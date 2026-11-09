"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type CurlProfile, PeelSimulation, type PeelSnapshot } from "@/lib/peel/PeelSimulation";
import { loadStickerAsset } from "@/lib/peel/StickerAsset";
import { PeelRenderer } from "@/lib/render/PeelRenderer";

const ACTIVE_LEVEL = {
  id: "octopus-v1",
  name: "Octopus",
  artwork: "/octopus-sticker.webp",
  tearThreshold: 0.24,
  releaseJumpThreshold: 0.28,
  liftedTransparency: 0.5,
} as const;
const TENSION_CONTROL_MAX = 0.33;
const RELEASE_JUMP_CONTROL_MAX = 0.33;
const tearThresholdStorageKey = `peel.level.${ACTIVE_LEVEL.id}.tearThreshold`;
const releaseJumpStorageKey = `peel.level.${ACTIVE_LEVEL.id}.releaseJumpThreshold`;
const liftedTransparencyStorageKey = `peel.level.${ACTIVE_LEVEL.id}.liftedTransparency`;

const emptySnapshot: PeelSnapshot = {
  moves: 0,
  maxMoves: 4,
  progress: 0,
  stress: 0,
  areaJump: 0,
  physicsSample: 0,
  tracking: false,
  pulling: false,
  canCommit: false,
  complete: false,
  failed: false,
  torn: false,
  tearDragging: false,
  tearThreshold: ACTIVE_LEVEL.tearThreshold,
  releaseJumpThreshold: ACTIVE_LEVEL.releaseJumpThreshold,
  tornOffset: { x: 0, y: 0 },
  grab: { x: 0.08, y: 0.5 },
  pointer: { x: 0.08, y: 0.5 },
  direction: { x: 1, y: 0 },
  frontDepth: 0,
};

function RollingSignalChart({
  label,
  value,
  threshold,
  position,
  pulse = false,
  sampleId = 0,
  scaleMax = 1,
}: {
  label: string;
  value: number;
  threshold: number;
  position: "tension" | "area-jump";
  pulse?: boolean;
  sampleId?: number;
  scaleMax?: number;
}) {
  const currentValue = useRef(value);
  const [samples, setSamples] = useState<number[]>(() => Array(51).fill(0));

  useEffect(() => {
    currentValue.current = pulse ? Math.max(currentValue.current, value) : value;
  }, [pulse, sampleId, value]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setSamples((history) => [...history.slice(-50), currentValue.current]);
      if (pulse) currentValue.current = 0;
    }, 100);
    return () => window.clearInterval(interval);
  }, [pulse]);

  const points = samples
    .map((sample, index) => `${(index / (samples.length - 1)) * 160},${64 - Math.min(1, sample / scaleMax) * 64}`)
    .join(" ");
  const thresholdY = 64 - Math.min(1, threshold / scaleMax) * 64;
  const displayedValue = pulse ? samples[samples.length - 1] : value;

  return (
    <aside className={`signal-chart ${position}-chart`} aria-label={`${label} over the last five seconds. Current value ${Math.round(displayedValue * 100)} percent.`}>
      <div><span>{label} · 5 sec</span><output>{Math.round(displayedValue * 100)}%</output></div>
      <svg viewBox="0 0 160 64" role="img" aria-hidden="true">
        <line className="signal-threshold" x1="0" x2="160" y1={thresholdY} y2={thresholdY} />
        <polygon className="signal-area" points={`0,64 ${points} 160,64`} />
        <polyline className="signal-line" points={points} />
      </svg>
    </aside>
  );
}

export default function PeelExperience() {
  const hostRef = useRef<HTMLDivElement>(null);
  const simulationRef = useRef<PeelSimulation | null>(null);
  const rendererRef = useRef<PeelRenderer | null>(null);
  const activePointer = useRef<number | null>(null);
  const textureFrame = useRef(0);
  const profileRef = useRef<CurlProfile>("cylinder");
  const [profile, setProfile] = useState<CurlProfile>("cylinder");
  const [debug, setDebug] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tearThreshold, setTearThreshold] = useState<number>(ACTIVE_LEVEL.tearThreshold);
  const [releaseJumpThreshold, setReleaseJumpThreshold] = useState<number>(ACTIVE_LEVEL.releaseJumpThreshold);
  const [liftedTransparency, setLiftedTransparency] = useState<number>(ACTIVE_LEVEL.liftedTransparency);
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
        const readSavedSetting = (key: string, fallback: number, minimum: number, maximum: number) => {
          const stored = Number(window.localStorage.getItem(key));
          return Number.isFinite(stored) && stored >= minimum && stored <= maximum ? stored : fallback;
        };
        let savedThreshold: number = ACTIVE_LEVEL.tearThreshold;
        let savedJumpThreshold: number = ACTIVE_LEVEL.releaseJumpThreshold;
        let savedTransparency: number = ACTIVE_LEVEL.liftedTransparency;
        try {
          savedThreshold = readSavedSetting(tearThresholdStorageKey, savedThreshold, 0, TENSION_CONTROL_MAX);
          savedJumpThreshold = readSavedSetting(releaseJumpStorageKey, savedJumpThreshold, 0, RELEASE_JUMP_CONTROL_MAX);
          savedTransparency = readSavedSetting(liftedTransparencyStorageKey, savedTransparency, 0.05, 0.9);
        } catch {
          // Storage can be unavailable in locked-down browser contexts; the level default remains valid.
        }
        setTearThreshold(savedThreshold);
        setReleaseJumpThreshold(savedJumpThreshold);
        setLiftedTransparency(savedTransparency);
        const simulation = new PeelSimulation(
          asset.width,
          asset.height,
          0x5045454c,
          4,
          asset.mask,
          savedThreshold,
          savedJumpThreshold,
        );
        const renderer = new PeelRenderer(hostRef.current, simulation, asset.image, asset.aspect);
        renderer.setLiftedTransparency(savedTransparency);
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
    const next = Math.max(0, Math.min(TENSION_CONTROL_MAX, value));
    setTearThreshold(next);
    simulationRef.current?.setTearThreshold(next);
    try {
      window.localStorage.setItem(tearThresholdStorageKey, next.toFixed(2));
    } catch {
      // The setting remains active for this session when persistent storage is unavailable.
    }
  };

  const changeReleaseJumpThreshold = (value: number) => {
    const next = Math.max(0, Math.min(RELEASE_JUMP_CONTROL_MAX, value));
    setReleaseJumpThreshold(next);
    simulationRef.current?.setReleaseJumpThreshold(next);
    try {
      window.localStorage.setItem(releaseJumpStorageKey, next.toFixed(2));
    } catch {
      // The setting remains active for this session when persistent storage is unavailable.
    }
  };

  const changeLiftedTransparency = (value: number) => {
    const next = Math.max(0.05, Math.min(0.9, value));
    setLiftedTransparency(next);
    rendererRef.current?.setLiftedTransparency(next);
    try {
      window.localStorage.setItem(liftedTransparencyStorageKey, next.toFixed(2));
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
        <RollingSignalChart
          label="Tension"
          value={snapshot.stress}
          threshold={tearThreshold}
          position="tension"
          scaleMax={TENSION_CONTROL_MAX}
        />
        <RollingSignalChart
          label="Area jump"
          value={snapshot.areaJump}
          threshold={releaseJumpThreshold}
          position="area-jump"
          pulse
          sampleId={snapshot.physicsSample}
          scaleMax={RELEASE_JUMP_CONTROL_MAX}
        />
        <p className="interaction-hint" aria-live="polite">{status}</p>

        {settingsOpen && (
          <aside className="physics-settings" aria-label="Level material settings">
            <label className="setting-control">
              <div><span>Tension tear</span><output>{Math.round(tearThreshold * 100)}%</output></div>
              <input
                type="range"
                min="0"
                max="33"
                step="1"
                value={Math.round(tearThreshold * 100)}
                onChange={(event) => changeTearThreshold(Number(event.currentTarget.value) / 100)}
              />
            </label>
            <label className="setting-control">
              <div><span>Area jump</span><output>{Math.round(releaseJumpThreshold * 100)}%</output></div>
              <input
                type="range"
                min="0"
                max="33"
                step="1"
                value={Math.round(releaseJumpThreshold * 100)}
                onChange={(event) => changeReleaseJumpThreshold(Number(event.currentTarget.value) / 100)}
              />
            </label>
            <label className="setting-control">
              <div><span>Lift transparency</span><output>{Math.round(liftedTransparency * 100)}%</output></div>
              <input
                type="range"
                min="5"
                max="90"
                step="1"
                value={Math.round(liftedTransparency * 100)}
                onChange={(event) => changeLiftedTransparency(Number(event.currentTarget.value) / 100)}
              />
            </label>
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
            <span>JUMP {Math.round(releaseJumpThreshold * 100)}%</span>
            <span>FILM {Math.round(liftedTransparency * 100)}%</span>
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
          <span>Physics</span>Tune
        </button>
        <button type="button" onClick={reset}>
          <span>Level</span>Reset
        </button>
      </footer>
    </main>
  );
}
