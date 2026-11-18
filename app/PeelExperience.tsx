"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CurlProfile,
  type PeelDiagnostics,
  PeelSimulation,
  type PeelSnapshot,
  type Vec2,
} from "@/lib/peel/PeelSimulation";
import { loadStickerAsset } from "@/lib/peel/StickerAsset";
import { PeelRenderer } from "@/lib/render/PeelRenderer";
import stickerLevels from "@/lib/peel/levels.json";

const DEFAULT_LEVEL = {
  pack: "Prototype",
  maxMoves: 4,
  id: "octopus-v1",
  name: "Octopus",
  artwork: "/octopus-sticker.webp",
  tearThreshold: 0.24,
  releaseJumpThreshold: 0.28,
  liftedTransparency: 0.5,
} as const;
const TENSION_CONTROL_MAX = 0.33;
const RELEASE_JUMP_CONTROL_MAX = 0.33;
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
  tearThreshold: DEFAULT_LEVEL.tearThreshold,
  releaseJumpThreshold: DEFAULT_LEVEL.releaseJumpThreshold,
  tornOffset: { x: 0, y: 0 },
  grab: { x: 0.08, y: 0.5 },
  pointer: { x: 0.08, y: 0.5 },
  direction: { x: 1, y: 0 },
  frontDepth: 0,
};

type DiagnosticEvent = {
  sequence: number;
  elapsedMs: number;
  type: string;
  point: Vec2 | null;
  profile: CurlProfile;
  snapshot: PeelSnapshot;
  solver: PeelDiagnostics;
  details: Record<string, string | number | boolean | null>;
};

function encodeStateRuns(state: Uint8Array) {
  const runs: Array<[number, number]> = [];
  if (state.length === 0) return runs;
  let value = state[0];
  let length = 1;
  for (let index = 1; index < state.length; index++) {
    if (state[index] === value) {
      length++;
    } else {
      runs.push([value, length]);
      value = state[index];
      length = 1;
    }
  }
  runs.push([value, length]);
  return runs;
}

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

type Level = { id: string; name: string; pack: string; artwork: string; maxMoves: number };
const LEVELS: Level[] = [DEFAULT_LEVEL, ...stickerLevels];
const PACKS = [...new Set(LEVELS.map(level => level.pack))];

export default function PeelExperience() {
  const [level, setLevel] = useState<Level>(DEFAULT_LEVEL);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("peel.selectedLevel");
      const found = LEVELS.find(item => item.id === saved);
      if (found) setLevel(found);
    } catch { /* Storage is optional. */ }
  }, []);
  const selectLevel = (next: Level) => {
    setLevel(next);
    try { localStorage.setItem("peel.selectedLevel", next.id); } catch { /* Storage is optional. */ }
  };
  return <PeelGame key={level.id} level={level} onLevelChange={selectLevel} />;
}

function PeelGame({ level, onLevelChange }: { level: Level; onLevelChange: (level: Level) => void }) {
  const tearThresholdStorageKey = `peel.level.${level.id}.tearThreshold`;
  const releaseJumpStorageKey = `peel.level.${level.id}.releaseJumpThreshold`;
  const liftedTransparencyStorageKey = `peel.level.${level.id}.liftedTransparency`;
  const levelIndex = LEVELS.findIndex(item => item.id === level.id);
  const hostRef = useRef<HTMLDivElement>(null);
  const simulationRef = useRef<PeelSimulation | null>(null);
  const rendererRef = useRef<PeelRenderer | null>(null);
  const activePointer = useRef<number | null>(null);
  const textureFrame = useRef(0);
  const profileRef = useRef<CurlProfile>("cylinder");
  const diagnosticEvents = useRef<DiagnosticEvent[]>([]);
  const diagnosticStartedAt = useRef(0);
  const diagnosticStartedWallClock = useRef("");
  const diagnosticSessionId = useRef("");
  const [profile, setProfile] = useState<CurlProfile>("cylinder");
  const [debug, setDebug] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tearThreshold, setTearThreshold] = useState<number>(DEFAULT_LEVEL.tearThreshold);
  const [releaseJumpThreshold, setReleaseJumpThreshold] = useState<number>(DEFAULT_LEVEL.releaseJumpThreshold);
  const [liftedTransparency, setLiftedTransparency] = useState<number>(DEFAULT_LEVEL.liftedTransparency);
  const [fps, setFps] = useState(60);
  const [ready, setReady] = useState(false);
  const [miss, setMiss] = useState(false);
  const [webglError, setWebglError] = useState(false);
  const [snapshot, setSnapshot] = useState<PeelSnapshot>(emptySnapshot);
  const [logStatus, setLogStatus] = useState("Recording locally");

  const recordDiagnostic = useCallback((
    type: string,
    point: Vec2 | null = null,
    details: Record<string, string | number | boolean | null> = {},
  ) => {
    const simulation = simulationRef.current;
    if (!simulation) return;
    const now = performance.now();
    if (diagnosticStartedAt.current === 0) diagnosticStartedAt.current = now;
    diagnosticEvents.current.push({
      sequence: diagnosticEvents.current.length,
      elapsedMs: Number((now - diagnosticStartedAt.current).toFixed(3)),
      type,
      point: point ? { ...point } : null,
      profile: profileRef.current,
      snapshot: simulation.snapshot(),
      solver: simulation.diagnostics(),
      details,
    });
  }, []);

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
        const asset = await loadStickerAsset(level.artwork);
        if (disposed || !hostRef.current) return;
        const readSavedSetting = (key: string, fallback: number, minimum: number, maximum: number) => {
          const stored = Number(window.localStorage.getItem(key) ?? Number.NaN);
          return Number.isFinite(stored) && stored >= minimum && stored <= maximum ? stored : fallback;
        };
        let savedThreshold: number = DEFAULT_LEVEL.tearThreshold;
        let savedJumpThreshold: number = DEFAULT_LEVEL.releaseJumpThreshold;
        let savedTransparency: number = DEFAULT_LEVEL.liftedTransparency;
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
          level.maxMoves,
          asset.mask,
          savedThreshold,
          savedJumpThreshold,
        );
        const renderer = new PeelRenderer(hostRef.current, simulation, asset.image, asset.aspect, level.artwork.startsWith("/stickers/"));
        renderer.setLiftedTransparency(savedTransparency);
        simulationRef.current = simulation;
        rendererRef.current = renderer;
        diagnosticEvents.current = [];
        diagnosticStartedAt.current = performance.now();
        diagnosticStartedWallClock.current = new Date().toISOString();
        diagnosticSessionId.current = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        setLogStatus("Recording locally");
        recordDiagnostic("session_start", null, {
          gridWidth: simulation.width,
          gridHeight: simulation.height,
          seed: "0x5045454c",
        });
        renderer.onFps = setFps;
        const canvas = renderer.domElement;
        canvas.setAttribute("aria-label", `Interactive ${level.name} sticker. Sweep from an exposed edge through the sticker to peel it.`);

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
          const simulationTime = performance.now();
          const accepted = point ? simulation.begin(point, simulationTime) : false;
          recordDiagnostic("pointer_down", point, {
            accepted,
            simulationTime,
            pointerId: event.pointerId,
            pointerType: event.pointerType,
          });
          if (!point || !accepted) return;
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
          const simulationTime = performance.now();
          simulation.drag(point, simulationTime);
          recordDiagnostic("pointer_move", point, {
            simulationTime,
            pointerId: event.pointerId,
          });
          const next = simulation.snapshot();
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
          const point = renderer.screenToSticker(event.clientX, event.clientY);
          recordDiagnostic(commit ? "pointer_up" : "pointer_cancel", point, {
            accepted,
            commit,
            hadGrab,
            pointerId: event.pointerId,
          });
          refresh(true);
          if (!accepted && !hadGrab) {
            setMiss(true);
            window.setTimeout(() => setMiss(false), 420);
          }
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
      textureFrame.current = 0;
      activePointer.current = null;
      teardown();
    };
  }, [level, recordDiagnostic, refresh, tearThresholdStorageKey, releaseJumpStorageKey, liftedTransparencyStorageKey]);

  const toggleProfile = () => {
    const next = profile === "cylinder" ? "cone" : "cylinder";
    profileRef.current = next;
    setProfile(next);
    recordDiagnostic("curl_profile", null, { profile: next });
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
    recordDiagnostic("tension_threshold", null, { value: next });
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
    recordDiagnostic("area_jump_threshold", null, { value: next });
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
    recordDiagnostic("lift_transparency", null, { value: next });
    try {
      window.localStorage.setItem(liftedTransparencyStorageKey, next.toFixed(2));
    } catch {
      // The setting remains active for this session when persistent storage is unavailable.
    }
  };

  const reset = () => {
    simulationRef.current?.reset();
    recordDiagnostic("level_reset");
    setMiss(false);
    refresh(true);
  };

  const buildDiagnosticLog = () => {
    const simulation = simulationRef.current;
    if (!simulation) return "";
    return JSON.stringify({
      schema: "peel-diagnostic-log-v1",
      sessionId: diagnosticSessionId.current,
      startedAt: diagnosticStartedWallClock.current,
      exportedAt: new Date().toISOString(),
      durationMs: Number((performance.now() - diagnosticStartedAt.current).toFixed(3)),
      level: {
        id: level.id,
        name: level.name,
        artwork: level.artwork,
        seed: "0x5045454c",
        gridWidth: simulation.width,
        gridHeight: simulation.height,
      },
      settings: {
        curlProfile: profileRef.current,
        tensionThreshold: simulation.snapshot().tearThreshold,
        areaJumpThreshold: simulation.snapshot().releaseJumpThreshold,
        liftedTransparency,
      },
      environment: {
        userAgent: navigator.userAgent,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      eventCount: diagnosticEvents.current.length,
      finalSnapshot: simulation.snapshot(),
      finalSolver: simulation.diagnostics(),
      stateLegend: { 0: "outside", 1: "adhered", 2: "released", 3: "lifted", 4: "torn" },
      finalStateRle: encodeStateRuns(simulation.state),
      events: diagnosticEvents.current,
    }, null, 2);
  };

  const copyDiagnosticLog = async () => {
    const log = buildDiagnosticLog();
    if (!log) return;
    try {
      await navigator.clipboard.writeText(log);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = log;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setLogStatus("Copied — paste it into this chat");
  };

  const downloadDiagnosticLog = () => {
    const log = buildDiagnosticLog();
    if (!log) return;
    const url = URL.createObjectURL(new Blob([log], { type: "application/json" }));
    const link = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    link.href = url;
    link.download = `peel-diagnostic-${stamp}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setLogStatus("Downloaded — attach the JSON here");
  };

  const clearDiagnosticLog = () => {
    diagnosticEvents.current = [];
    diagnosticStartedAt.current = performance.now();
    diagnosticStartedWallClock.current = new Date().toISOString();
    diagnosticSessionId.current = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setLogStatus("New recording started");
    recordDiagnostic("session_start", null, { reason: "manual_clear" });
  };

  const percent = Math.min(100, Math.round(snapshot.progress * 100));
  const status = snapshot.torn
    ? snapshot.tearDragging
      ? "Level failed — move the torn piece, then let go."
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
        <nav className="level-switcher" aria-label="Choose sticker level">
          <button type="button" aria-label="Previous level" disabled={levelIndex === 0} onClick={() => onLevelChange(LEVELS[levelIndex - 1])}>‹</button>
          <label>
            <span>LEVEL {levelIndex + 1} / {LEVELS.length}</span>
            <select aria-label="Sticker level" value={level.id} onChange={event => onLevelChange(LEVELS.find(item => item.id === event.target.value)!)}>
              {PACKS.map(pack => <optgroup key={pack} label={pack}>
                {LEVELS.filter(item => item.pack === pack).map(item => <option key={item.id} value={item.id}>{item.name} · {item.maxMoves} moves</option>)}
              </optgroup>)}
            </select>
          </label>
          <button type="button" aria-label="Next level" disabled={levelIndex === LEVELS.length - 1} onClick={() => onLevelChange(LEVELS[levelIndex + 1])}>›</button>
        </nav>
        <div className="readouts" aria-label="Level status">
          <span>MOVES&nbsp; {snapshot.moves} / {snapshot.maxMoves}</span>
          <span>RELEASED&nbsp; {String(percent).padStart(2, "0")}%</span>
        </div>
      </header>

      <section className="stage" aria-label="Sticker peeling prototype">
        <div className="surface-glow" aria-hidden="true" />
        <div ref={hostRef} className="renderer-host" />
        {!ready && !webglError && <p className="loading-art">Preparing sticker…</p>}
        {webglError && (
          <div className="webgl-fallback" role="alert">
            <strong>Couldn’t prepare this sticker.</strong>
            <span>Choose another level or reload with WebGL enabled.</span>
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
        <button
          type="button"
          className="log-eraser-button"
          onClick={clearDiagnosticLog}
          aria-label="Clear diagnostic log and start a new recording"
          title="Clear diagnostic log"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m14.7 4.3 5 5a2 2 0 0 1 0 2.8l-7.2 7.2H7.8L3.3 14.8a2 2 0 0 1 0-2.8l8.6-7.7a2 2 0 0 1 2.8 0Z" />
            <path d="m8.2 19.3 7.8-7.8M12.5 19.3H21" />
          </svg>
        </button>
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
            <small>Autosaved for {level.name}</small>
            <section className="log-tools" aria-label="Diagnostic recording">
              <header><span>Diagnostic log</span><output>{diagnosticEvents.current.length} events</output></header>
              <p>Local only. Reproduce the fast release, then copy or download the complete trace.</p>
              <div className="log-actions">
                <button type="button" onClick={() => void copyDiagnosticLog()}>Copy log</button>
                <button type="button" onClick={downloadDiagnosticLog}>Download JSON</button>
                <button type="button" onClick={clearDiagnosticLog}>Clear</button>
              </div>
              <small role="status">{logStatus}</small>
            </section>
          </aside>
        )}

        {!snapshot.tearDragging && (snapshot.complete || snapshot.failed) && (
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
