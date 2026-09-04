"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PeelSimulation, type CurlProfile, type PeelSnapshot } from "@/lib/peel/PeelSimulation";
import { PeelRenderer } from "@/lib/render/PeelRenderer";

const initialSimulation = () => new PeelSimulation(144, 132, 0x5045454c, 4);

export default function PeelExperience() {
  const hostRef = useRef<HTMLDivElement>(null);
  const simulationRef = useRef<PeelSimulation | null>(null);
  if (!simulationRef.current) simulationRef.current = initialSimulation();
  const rendererRef = useRef<PeelRenderer | null>(null);
  const activePointer = useRef<number | null>(null);
  const textureFrame = useRef(0);
  const profileRef = useRef<CurlProfile>("cylinder");
  const [profile, setProfile] = useState<CurlProfile>("cylinder");
  const [debug, setDebug] = useState(false);
  const [fps, setFps] = useState(60);
  const [started, setStarted] = useState(false);
  const [miss, setMiss] = useState(false);
  const [webglError, setWebglError] = useState(false);
  const [snapshot, setSnapshot] = useState<PeelSnapshot>(() => simulationRef.current!.snapshot());

  const refresh = useCallback((updateTexture = true) => {
    const simulation = simulationRef.current!;
    const renderer = rendererRef.current;
    const next = simulation.snapshot();
    if (updateTexture) renderer?.updateState();
    renderer?.setPeel(next.grab, next.inward, next.peelDepth, profileRef.current, next.stress);
    setSnapshot(next);
  }, []);

  useEffect(() => {
    if (!hostRef.current) return;
    const simulation = simulationRef.current!;
    let renderer: PeelRenderer;
    try {
      renderer = new PeelRenderer(hostRef.current, simulation);
    } catch {
      setWebglError(true);
      return;
    }
    rendererRef.current = renderer;
    renderer.onFps = setFps;
    const canvas = renderer.domElement;
    canvas.setAttribute("aria-label", "Interactive sticker. Drag a visible edge away from the center to peel it.");

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
      if (!point || !simulation.begin(point, performance.now())) {
        setMiss(true);
        window.setTimeout(() => setMiss(false), 420);
        return;
      }
      event.preventDefault();
      activePointer.current = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      setStarted(true);
      refresh(true);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (activePointer.current !== event.pointerId) return;
      const point = renderer.screenToSticker(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      simulation.drag(point, performance.now());
      const next = simulation.snapshot();
      renderer.setPeel(next.grab, next.inward, next.peelDepth, profileRef.current, next.stress);
      scheduleTextureRefresh();
    };

    const finishPointer = (event: PointerEvent, commit: boolean) => {
      if (activePointer.current !== event.pointerId) return;
      activePointer.current = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      simulation.end(commit);
      refresh(true);
      if (navigator.vibrate && commit) navigator.vibrate(12);
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove, { passive: false });
    canvas.addEventListener("pointerup", (event) => finishPointer(event, true));
    canvas.addEventListener("pointercancel", (event) => finishPointer(event, false));

    return () => {
      if (textureFrame.current) cancelAnimationFrame(textureFrame.current);
      renderer.dispose();
      rendererRef.current = null;
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

  const reset = () => {
    simulationRef.current!.reset();
    setStarted(false);
    setMiss(false);
    refresh(true);
  };

  const percent = Math.min(100, Math.round(snapshot.progress * 100));
  const status = snapshot.complete
    ? "Clean release — the sticker stayed intact."
    : snapshot.failed
      ? "The adhesive held. Try broader, longer pulls."
      : snapshot.pulling
        ? snapshot.stress > 0.72 ? "High tension — ease the pull." : "Keep the front moving."
        : snapshot.moves > 0 ? "Catch the new exposed boundary." : "Catch an edge or a cutout, then pull away.";

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
        {!started && !webglError && <i className="grab-guide" aria-hidden="true" />}
        {webglError && (
          <div className="webgl-fallback" role="alert">
            <strong>3D graphics are unavailable.</strong>
            <span>Open this page in a browser with WebGL enabled.</span>
          </div>
        )}
        <div className="meter" aria-label={`Tension ${Math.round(snapshot.stress * 100)} percent`}>
          <span>Tension</span>
          <i><b style={{ transform: `scaleX(${Math.min(1, snapshot.stress)})` }} /></i>
        </div>
        <p className="interaction-hint" aria-live="polite">{status}</p>

        {(snapshot.complete || snapshot.failed) && (
          <div className="result-card" role="dialog" aria-modal="false" aria-label="Level result">
            <span>{snapshot.complete ? "RELEASED" : "OUT OF MOVES"}</span>
            <strong>{snapshot.complete ? "One piece. No tears." : `${percent}% came free.`}</strong>
            <button type="button" onClick={reset}>Try again</button>
          </div>
        )}

        {debug && (
          <aside className="debug-panel">
            <span>FPS {fps}</span>
            <span>GRID 144×132</span>
            <span>FRONT {(snapshot.peelDepth * 100).toFixed(1)}</span>
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
        <button type="button" onClick={reset}>
          <span>Level</span>Reset
        </button>
      </footer>
    </main>
  );
}
