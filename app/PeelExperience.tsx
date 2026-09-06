"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type CurlProfile, PeelSimulation, type PeelSnapshot } from "@/lib/peel/PeelSimulation";
import { loadStickerAsset } from "@/lib/peel/StickerAsset";
import { PeelRenderer } from "@/lib/render/PeelRenderer";

const ACTIVE_LEVEL = {
  id: "octopus-v1",
  name: "Octopus",
  artwork: "/octopus-sticker.webp",
  tearThreshold: 0.72,
} as const;
const tearThresholdStorageKey = `peel.level.${ACTIVE_LEVEL.id}.tearThreshold`;

const emptySnapshot: PeelSnapshot = {
  moves: 0,
  maxMoves: 4,
  progress: 0,
  stress: 0,
  tracking: false,
  pulling: false,
  canCommit: false,
  complete: false,
  failed: false,
  torn: false,
  tearDragging: false,
  tearThreshold: ACTIVE_LEVEL.tearThreshold,
  tornOffset: { x: 0, y: 0 },
  grab: { x: 0.08, y: 0.5 },
  pointer: { x: 0.08, y: 0.5 },
  direction: { x: 1, y: 0 },
  frontDepth: 0,
};

export default function PeelExperience() {
  const hostRef = useRef<HTMLDivElement>(null);
  const simulationRef = useRef<PeelSimulation | null>(null);
  const rendererRef = useRef<PeelRenderer | null>(null);
  const activePointer = useRef<number | null>(null);
  const textureFrame = useRef(0);
  const profileRef = useRef<CurlProfile>("cylinder");
  const tearThresholdRef = useRef<number>(ACTIVE_LEVEL.tearThreshold);
  const [profile, setProfile] = useState<CurlProfile>("cylinder");
  const [debug, setDebug] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tearThreshold, setTearThreshold] = useState<number>(ACTIVE_LEVEL.tearThreshold);
  const [fps, setFps] = useState(60);
  const [ready, setReady] = useState(false);
  const [started, setStarted] = useState(false);
  const [miss, setMiss] = useState(false);
  const [webglError, setWebglError] = useState(false);
  const [snapshot, setSnapshot] = useState<PeelSnapshot>(emptySnapshot);

  const refresh = useCallback((updateTexture = true) => {
    const simulation = simulationRef.current;
    const renderer = rendererRef.current;
    if (!simulation) return;
    const next = simulation.snapshot();
    if (updateTexture) renderer?.updateState();
    renderer?.setPeel(
      next.grab,
      next.pointer,
      next.direction,
      next.frontDepth,
      profileRef.current,
      next.stress,
      next.tornOffset,
      next.torn,
    );
    setSnapshot(next);
  }, []);

  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;
    let teardown = () => {};

    void (async () => {
      try {
        const asset = await loadStickerAsset(ACTIVE_LEVEL.artwork);
        if (disposed || !hostRef.current) return;
        let savedThreshold: number = ACTIVE_LEVEL.tearThreshold;
        try {
          const stored = Number(window.localStorage.getItem(tearThresholdStorageKey));
          if (Number.isFinite(stored) && stored >= 0.35 && stored <= 0.98) savedThreshold = stored;
        } catch {
          // Storage can be unavailable in locked-down browser contexts; the level default remains valid.
        }
        tearThresholdRef.current = savedThreshold;
        setTearThreshold(savedThreshold);
        const simulation = new PeelSimulation(asset.width, asset.height, 0x5045454c, 4, asset.mask, savedThreshold);
        const renderer = new PeelRenderer(hostRef.current, simulation, asset.image, asset.aspect, "bubble");
        simulationRef.current = simulation;
        rendererRef.current = renderer;
        renderer.onFps = setFps;
        const canvas = renderer.domElement;
        canvas.setAttribute("aria-label", "Interactive octopus sticker. Sweep from an exposed edge through the sticker to peel it.");

        const scheduleTextureRefresh = () => {
          if (textureFrame.current) return;
          textureFrame.current = requestAnimationFrame(() => {
            textureFrame.current = 0;
            refresh(true);
          });
        };

        const onPointerDown = (event: PointerEvent) => {
          if (activePointer.current !== null) return;
          const point = renderer.screenToSticker(event.clientX, event.clientY);
          if (!point || !simulation.begin(point, performance.now())) return;
          event.preventDefault();
          activePointer.current = event.pointerId;
          canvas.setPointerCapture(event.pointerId);
          refresh(false);
        };

        const onPointerMove = (event: PointerEvent) => {
          if (activePointer.current !== event.pointerId) return;
          const point = renderer.screenToSticker(event.clientX, event.clientY);
          if (!point) return;
          event.preventDefault();
          const wasTorn = simulation.snapshot().torn;
          simulation.drag(point, performance.now());
          const next = simulation.snapshot();
          if (next.pulling) setStarted(true);
          renderer.setPeel(
            next.grab,
            next.pointer,
            next.direction,
            next.frontDepth,
            profileRef.current,
            next.stress,
            next.tornOffset,
            next.torn,
          );
          setSnapshot(next);
          scheduleTextureRefresh();
          if (!wasTorn && next.torn && navigator.vibrate) navigator.vibrate([22, 34, 28]);
        };

        const finishPointer = (event: PointerEvent, commit: boolean) => {
          if (activePointer.current !== event.pointerId) return;
          activePointer.current = null;
          if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
          const hadGrab = simulation.snapshot().pulling;
          const accepted = simulation.end(commit);
          refresh(true);
          if (!accepted && !hadGrab) {
            setMiss(true);
            window.setTimeout(() => setMiss(false), 420);
          }
          const ended = simulation.snapshot();
          if (ended.moves === 0 && !ended.torn) setStarted(false);
          if (navigator.vibrate && accepted) navigator.vibrate(12);
        };

        const onPointerUp = (event: PointerEvent) => finishPointer(event, true);
        const onPointerCancel = (event: PointerEvent) => finishPointer(event, false);
        canvas.addEventListener("pointerdown", onPointerDown);
        canvas.addEventListener("pointermove", onPointerMove, { passive: false });
        canvas.addEventListener("pointerup", onPointerUp);
        canvas.addEventListener("pointercancel", onPointerCancel);

        teardown = () => {
          canvas.removeEventListener("pointerdown", onPointerDown);
          canvas.removeEventListener("pointermove", onPointerMove);
          canvas.removeEventListener("pointerup", onPointerUp);
          canvas.removeEventListener("pointercancel", onPointerCancel);
          renderer.dispose();
          rendererRef.current = null;
          simulationRef.current = null;
        };
        setSnapshot(simulation.snapshot());
        setReady(true);
      } catch {
        if (!disposed) setWebglError(true);
      }
    })();

    return () => {
      disposed = true;
      if (textureFrame.current) cancelAnimationFrame(textureFrame.current);
      teardown();
    };
  }, [refresh]);

  const toggleProfile = () => {
    const next = profile === "cylinder" ? "cone" : "cylinder";
    profileRef.current = next;
    setProfile(next);
    refresh(false);
  };

  const toggleDebug = () => {
    const next = !debug;
    setDebug(next);
    rendererRef.current?.setDebug(next);
  };

  const changeTearThreshold = (value: number) => {
    const next = Math.max(0.35, Math.min(0.98, value));
    tearThresholdRef.current = next;
    setTearThreshold(next);
    simulationRef.current?.setTearThreshold(next);
    try {
      window.localStorage.setItem(tearThresholdStorageKey, next.toFixed(2));
    } catch {
      // The setting remains active for this session when persistent storage is unavailable.
    }
  };

  const reset = () => {
    simulationRef.current?.reset();
    setStarted(false);
    setMiss(false);
    refresh(true);
  };

  const percent = Math.min(100, Math.round(snapshot.progress * 100));
  const status = snapshot.torn
    ? snapshot.tearDragging
      ? "Torn — move the detached piece, then release it."
      : "The lifted piece separated from the sticker."
    : snapshot.complete
    ? "Clean release — the sticker stayed intact."
    : snapshot.failed
      ? "The adhesive held. Try broader pulls through the body."
      : snapshot.tracking && !snapshot.pulling
        ? "Cross an exposed edge to pick it up."
        : snapshot.pulling
          ? snapshot.stress > tearThreshold * 0.86 ? "The material is necking — change direction." : "Keep sweeping the peel front."
          : snapshot.moves > 0 ? "Use the new exposed boundary for the next sweep." : "Start on an edge and sweep through the sticker.";

  return (
    <main className={`prototype-shell ${miss ? "miss" : ""}`}>
      <header className="prototype-header">
        <div className="brand-block">
          <p className="eyebrow">Interactive material study</p>
          <h1>PEEL</h1>
        </div>
        <div className="readouts" aria-label="Level status">
          <span>MOVES&nbsp; {snapshot.moves} / {snapshot.maxMoves}</span>
          <span>RELEASED&nbsp; {String(percent).padStart(2, "0")}%</span>
        </div>
      </header>

      <section className="stage" aria-label="Sticker peeling prototype">
        <div className="surface-glow" aria-hidden="true" />
        <div ref={hostRef} className="renderer-host" />
        {!started && ready && !webglError && <i className="grab-guide" aria-hidden="true" />}
        {!ready && !webglError && <p className="loading-art">Preparing sticker…</p>}
        {webglError && (
          <div className="webgl-fallback" role="alert">
            <strong>3D graphics are unavailable.</strong>
            <span>Open this page in a browser with WebGL enabled.</span>
          </div>
        )}
        <div className="meter" aria-label={`Tension ${Math.round(snapshot.stress * 100)} percent`}>
          <span>Tension</span>
          <i>
            <b style={{ transform: `scaleX(${Math.min(1, snapshot.stress)})` }} />
            <em style={{ left: `${tearThreshold * 100}%` }} aria-hidden="true" />
          </i>
        </div>
        <p className="interaction-hint" aria-live="polite">{status}</p>

        {settingsOpen && (
          <aside className="tear-settings" aria-label="Level tear settings">
            <div>
              <span>Tear threshold</span>
              <output>{Math.round(tearThreshold * 100)}%</output>
            </div>
            <input
              type="range"
              min="35"
              max="98"
              step="1"
              value={Math.round(tearThreshold * 100)}
              aria-label="Tear threshold percentage"
              onChange={(event) => changeTearThreshold(Number(event.currentTarget.value) / 100)}
            />
            <small>Autosaved for {ACTIVE_LEVEL.name}</small>
          </aside>
        )}

        {(snapshot.complete || snapshot.failed) && (
          <div className="result-card" role="dialog" aria-modal="false" aria-label="Level result">
            <span>{snapshot.complete ? "RELEASED" : snapshot.torn ? "TORN" : "OUT OF MOVES"}</span>
            <strong>
              {snapshot.complete ? "One piece. No tears." : snapshot.torn ? "The lifted piece separated." : `${percent}% came free.`}
            </strong>
            <button type="button" onClick={reset}>Try again</button>
          </div>
        )}

        {debug && (
          <aside className="debug-panel">
            <span>FPS {fps}</span>
            <span>GRID {simulationRef.current?.width ?? 208}×{simulationRef.current?.height ?? 166}</span>
            <span>FRONT {(snapshot.frontDepth * 100).toFixed(1)}</span>
            <span>TEAR {Math.round(tearThreshold * 100)}%</span>
            <span>GPU WEBGL</span>
          </aside>
        )}
      </section>

      <footer className="control-bar" aria-label="Prototype settings">
        <button type="button" onClick={toggleProfile} aria-label={`Curl profile: ${profile}`}>
          <span>Curl</span>{profile}
        </button>
        <button type="button" onClick={toggleDebug} aria-pressed={debug}>
          <span>Debug</span>{debug ? "On" : "Off"}
        </button>
        <button type="button" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen}>
          <span>Tear</span>{Math.round(tearThreshold * 100)}%
        </button>
        <button type="button" onClick={reset}>
          <span>Level</span>Reset
        </button>
      </footer>
    </main>
  );
}
