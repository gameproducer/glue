"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  type CurlProfile,
  type PeelDiagnostics,
  PeelSimulation,
  type PeelSnapshot,
  type TearFactors,
  type Vec2,
} from "@/lib/peel/PeelSimulation";
import { loadStickerAsset } from "@/lib/peel/StickerAsset";
import { PEEL_SOUNDS, PeelAudio, type PeelSound } from "@/lib/peel/PeelAudio";
import { REFERENCE_PEEL_SOUNDS } from "@/lib/peel/ReferencePeelSound";
import { PEEL_SOUND_RESPONSES, peelSoundLoad, type PeelSoundResponse } from "@/lib/peel/PeelSoundResponse";
import { APPEARANCE_OPTIONS, FIRST_REFRACTIVE_FINISH, LEGACY_RIDGE_FINISH, type PeelAppearance } from "@/lib/render/PeelAppearance";
import { MAX_EDGE_CLEARANCE, MIN_EDGE_CLEARANCE, type CameraSettings } from "@/lib/render/PeelFraming";
import {
  DEFAULT_LEVEL_SETTINGS, RELEASE_JUMP_CONTROL_MAX, TENSION_CONTROL_MAX, ZOOM_STEPS,
  readLevelSettings, saveLevelSettings, sensitivityToThreshold, thresholdToSensitivity, type LevelSettings,
} from "@/lib/peel/LevelSettings";
import { PeelRenderer } from "@/lib/render/PeelRenderer";
import stickerLevels from "@/lib/peel/levels.json";

const DEFAULT_LEVEL = {
  pack: "Prototype",
  maxMoves: 4,
  id: "octopus-v1",
  name: "Octopus",
  artwork: "/octopus-sticker.webp",
} as const;
// A screen-space cap tuned to roughly 1.5 cm on an iPhone at normal page scale.
const GRIP_GAP_LIMIT_PX = 84;
const TEAR_FACTOR_CONTROLS = [
  { key: "outward", label: "Outward pull", hint: "How easily a lifted flap tears when pulled back." },
  { key: "bottleneck", label: "Thin neck", hint: "Extra tension when a narrow connection carries the pull between wider sections." },
] as const;
const emptySnapshot: PeelSnapshot = {
  moves: 0,
  maxMoves: 4,
  progress: 0,
  stress: 0,
  areaJump: 0,
  physicsSample: 0,
  tracking: false,
  pulling: false,
  outwardPulling: false,
  canCommit: false,
  detached: false,
  complete: false,
  failed: false,
  tearFailure: null,
  torn: false,
  tearDragging: false,
  tearThreshold: DEFAULT_LEVEL_SETTINGS.tearThreshold,
  releaseJumpThreshold: DEFAULT_LEVEL_SETTINGS.releaseJumpThreshold,
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

function FragilitySlider({ label, value, hint, onChange }: {
  label: string;
  value: number;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="setting-control" title={hint}>
      <div><span>{label}</span><output>{value}%</output></div>
      <input type="range" min="0" max="100" step="1" aria-label={label} aria-valuetext={`${value}% sensitivity`}
        value={value} onChange={event => onChange(event.currentTarget.valueAsNumber)} />
    </label>
  );
}

function SettingsDialog({ id, title, levelName, onDismiss, children }: {
  id: string;
  title: string;
  levelName: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog ref={ref} id={id} className="settings-dialog" aria-labelledby="settings-title"
      onCancel={event => { event.preventDefault(); onDismiss(); }}
      onClick={event => { if (event.target === event.currentTarget) onDismiss(); }}>
      <div className="settings-sheet">
        <header className="settings-header">
          <div>
            <h2 id="settings-title">{title}</h2>
            <p>Autosaved for {levelName}</p>
          </div>
          <button type="button" onClick={onDismiss} autoFocus>Done</button>
        </header>
        <div className="settings-grid">{children}</div>
      </div>
    </dialog>
  );
}

export default function PeelExperience() {
  const [level, setLevel] = useState<Level>(DEFAULT_LEVEL);
  const [bottomPanelOpen, setBottomPanelOpen] = useState(true);
  const [audio] = useState(() => new PeelAudio());
  useEffect(() => () => audio.dispose(), [audio]);
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
  return <PeelGame key={level.id} level={level} onLevelChange={selectLevel}
    bottomPanelOpen={bottomPanelOpen} onBottomPanelChange={setBottomPanelOpen} audio={audio} />;
}

function PeelGame({ level, onLevelChange, bottomPanelOpen, onBottomPanelChange, audio }: {
  level: Level;
  onLevelChange: (level: Level) => void;
  bottomPanelOpen: boolean;
  onBottomPanelChange: (open: boolean) => void;
  audio: PeelAudio;
}) {
  const levelIndex = LEVELS.findIndex(item => item.id === level.id);
  const hostRef = useRef<HTMLDivElement>(null);
  const simulationRef = useRef<PeelSimulation | null>(null);
  const rendererRef = useRef<PeelRenderer | null>(null);
  const activePointer = useRef<number | null>(null);
  const textureFrame = useRef(0);
  const moveToastTimer = useRef<number | null>(null);
  const diagnosticEvents = useRef<DiagnosticEvent[]>([]);
  const diagnosticStartedAt = useRef(0);
  const diagnosticStartedWallClock = useRef("");
  const diagnosticSessionId = useRef("");
  const settingsRef = useRef(DEFAULT_LEVEL_SETTINGS);
  const [settings, setSettings] = useState(DEFAULT_LEVEL_SETTINGS);
  const {
    profile, appearance, peelSound, peelVolume, soundResponse, tearThreshold, releaseJumpThreshold,
    liftedTransparency, tearFactors, tearWarning, zoom, edgeClick, releaseDynamics, camera: cameraSettings,
  } = settings;
  const zoomIndex = ZOOM_STEPS.indexOf(zoom);
  const [menu, setMenu] = useState<"physics" | "visuals" | "camera-sound" | null>(null);
  const soundDescription = REFERENCE_PEEL_SOUNDS.find(({ id }) => id === peelSound)?.description;
  const pendingSound = useRef({ progress: 0, peak: 0 });
  const [ready, setReady] = useState(false);
  const [miss, setMiss] = useState(false);
  const [webglError, setWebglError] = useState(false);
  const [snapshot, setSnapshot] = useState<PeelSnapshot>(emptySnapshot);
  const [moveLimitToast, setMoveLimitToast] = useState(false);
  const [logStatus, setLogStatus] = useState("Recording locally");

  const updateSettings = (patch: Partial<LevelSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    saveLevelSettings(level.id, next);
  };

  useEffect(() => {
    rendererRef.current?.setSettingsOpen(menu !== null);
  }, [menu, ready]);

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
      profile: settingsRef.current.profile,
      snapshot: simulation.snapshot(),
      solver: simulation.diagnostics(),
      details,
    });
  }, []);

  const startDiagnosticRecording = useCallback((reason: "level_load" | "level_reset" | "manual_clear") => {
    const simulation = simulationRef.current;
    if (!simulation) return;
    diagnosticEvents.current = [];
    diagnosticStartedAt.current = performance.now();
    rendererRef.current?.frameTimings.clear();
    diagnosticStartedWallClock.current = new Date().toISOString();
    diagnosticSessionId.current = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setLogStatus(reason === "level_load" ? "Recording locally" : "New recording started");
    recordDiagnostic("session_start", null, {
      reason,
      gridWidth: simulation.width,
      gridHeight: simulation.height,
      seed: "0x5045454c",
    });
  }, [recordDiagnostic]);

  const refresh = useCallback((updateTexture = true, checkGrip = false, edgeReleased = false) => {
    const simulation = simulationRef.current;
    const renderer = rendererRef.current;
    if (!simulation) return;
    let next = simulation.snapshot();
    const textureStarted = performance.now();
    let gripDistance: number | null = null;
    if (updateTexture) renderer?.updateState();
    if (checkGrip && renderer) {
      const gapPx = renderer.gripGap(next, settingsRef.current.profile);
      gripDistance = gapPx;
      if (gapPx !== null && gapPx > GRIP_GAP_LIMIT_PX / 4) {
        const tore = simulation.applyGripGap(gapPx, GRIP_GAP_LIMIT_PX,
          gapPx >= GRIP_GAP_LIMIT_PX ? renderer.tornGripContact() : null);
        if (tore) {
          renderer.updateState();
          if (navigator.vibrate) navigator.vibrate([22, 34, 28]);
        }
        next = simulation.snapshot();
        recordDiagnostic("grip_gap", next.pointer, { gapPx, limitPx: GRIP_GAP_LIMIT_PX });
      }
    }
    if (checkGrip) {
      const { progress, peak } = pendingSound.current;
      if (next.torn || next.detached) audio.stopPeeling();
      else if (activePointer.current !== null && next.pulling) {
        audio.playProgress(settingsRef.current.peelSound, progress, peelSoundLoad(next, gripDistance, GRIP_GAP_LIMIT_PX), peak);
      }
      if (edgeReleased && !next.torn) audio.playEdgeClick();
      pendingSound.current = { progress: 0, peak: 0 };
    }
    const poseStarted = performance.now();
    renderer?.setPeel(
      next.grab,
      next.direction,
      next.frontDepth,
      settingsRef.current.profile,
      next.stress,
      next.tearThreshold,
      next.tornOffset,
      next.torn,
      next.detached ? next.pointer : undefined,
    );
    renderer?.setTearWarning(next, settingsRef.current.tearWarning
      ? simulation.tearWarning(gripDistance, GRIP_GAP_LIMIT_PX) : null);
    renderer?.frameTimings.recordState(poseStarted - textureStarted, performance.now() - poseStarted);
    setSnapshot(next);
  }, [audio, recordDiagnostic]);

  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;
    let teardown = () => {};
    const saved = readLevelSettings(level.id);
    settingsRef.current = saved;
    setSettings(saved);
    audio.setVolume(saved.peelVolume);
    audio.setResponse(saved.soundResponse);
    audio.setReleaseDynamics(saved.releaseDynamics);

    void (async () => {
      try {
        const asset = await loadStickerAsset(level.artwork);
        if (disposed || !hostRef.current) return;
        const current = settingsRef.current;
        const simulation = new PeelSimulation(
          asset.width,
          asset.height,
          0x5045454c,
          level.maxMoves,
          asset.mask,
          current.tearThreshold,
          current.releaseJumpThreshold,
        );
        simulation.setTearFactors(current.tearFactors);
        const renderer = new PeelRenderer(hostRef.current, simulation, asset.image, asset.aspect,
          level.artwork.startsWith("/stickers/"), current.camera, current.zoom / 100);
        renderer.setLiftedTransparency(current.liftedTransparency);
        renderer.setAppearance(current.appearance);
        simulationRef.current = simulation;
        rendererRef.current = renderer;
        startDiagnosticRecording("level_load");
        const canvas = renderer.domElement;
        canvas.setAttribute("aria-label", `Interactive ${level.name} sticker. Sweep from an exposed edge through the sticker to peel it.`);

        const scheduleTextureRefresh = () => {
          if (textureFrame.current) return;
          textureFrame.current = requestAnimationFrame(() => {
            textureFrame.current = 0;
            refresh(true, true);
          });
        };

        const onPointerDown = (event: PointerEvent) => {
          if (activePointer.current !== null) return;
          const point = renderer.screenToSticker(event.clientX, event.clientY);
          const simulationTime = performance.now();
          const accepted = point ? simulation.begin(point, simulationTime) : false;
          const solverMs = performance.now() - simulationTime;
          renderer.frameTimings.recordInput(solverMs);
          recordDiagnostic("pointer_down", point, {
            accepted,
            simulationTime,
            solverMs,
            pointerId: event.pointerId,
            pointerType: event.pointerType,
          });
          if (!point || !accepted) return;
          if (settingsRef.current.peelSound !== "off" || settingsRef.current.edgeClick) audio.unlock();
          audio.beginGesture();
          pendingSound.current = { progress: 0, peak: 0 };
          event.preventDefault();
          activePointer.current = event.pointerId;
          canvas.setPointerCapture(event.pointerId);
          renderer.beginDrag(event.clientX, event.clientY, point);
          refresh(false);
        };

        const onPointerMove = (event: PointerEvent) => {
          if (activePointer.current !== event.pointerId) return;
          const point = renderer.dragToSticker(event.clientX, event.clientY);
          if (!point) return;
          event.preventDefault();
          const before = simulation.snapshot();
          const simulationTime = performance.now();
          const feedback = simulation.drag(point, simulationTime);
          const solverMs = performance.now() - simulationTime;
          renderer.frameTimings.recordInput(solverMs);
          recordDiagnostic("pointer_move", point, {
            simulationTime,
            solverMs,
            pointerId: event.pointerId,
            edgeReleased: feedback?.edgeReleased ?? false,
            releasedFraction: feedback?.releasedFraction ?? 0,
          });
          const next = simulation.snapshot();
          if (feedback) {
            const pending = pendingSound.current;
            pending.progress += Math.max(0, next.progress - before.progress);
            pending.peak = Math.max(pending.peak, feedback.releasedFraction);
          }
          if (feedback?.edgeReleased && settingsRef.current.edgeClick) {
            if (textureFrame.current) cancelAnimationFrame(textureFrame.current);
            textureFrame.current = 0;
            refresh(true, true, true);
          } else {
            scheduleTextureRefresh();
          }
          if (!before.torn && next.torn && navigator.vibrate) navigator.vibrate([22, 34, 28]);
        };

        const finishPointer = (event: PointerEvent) => {
          if (activePointer.current !== event.pointerId) return;
          const releasedByPlayer = event.type === "pointerup";
          if (releasedByPlayer) onPointerMove(event);
          if (textureFrame.current) {
            cancelAnimationFrame(textureFrame.current);
            textureFrame.current = 0;
            refresh(true, true);
          }
          if (releasedByPlayer && settingsRef.current.peelSound !== "off") audio.unlock();
          activePointer.current = null;
          pendingSound.current = { progress: 0, peak: 0 };
          audio.stopPeeling();
          if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
          const beforeRelease = simulation.snapshot();
          const hadGrab = beforeRelease.pulling;
          const lift = hadGrab && !beforeRelease.detached && !beforeRelease.torn ? simulation.diagnostics().current : null;
          if (beforeRelease.detached) refresh(true);
          // Browser interruptions settle the last valid lift like a normal release.
          const solverStarted = performance.now();
          const accepted = simulation.end();
          const solverMs = performance.now() - solverStarted;
          renderer.frameTimings.recordInput(solverMs);
          const finished = simulation.snapshot();
          if (accepted && finished.moves === finished.maxMoves + 1) {
            setMoveLimitToast(true);
            moveToastTimer.current = window.setTimeout(() => setMoveLimitToast(false), 2800);
          }
          recordDiagnostic(releasedByPlayer ? "pointer_up" : "pointer_cancel", beforeRelease.pointer, {
            accepted,
            commit: true,
            hadGrab,
            outwardPulling: beforeRelease.outwardPulling,
            pointerId: event.pointerId,
            source: event.type,
            canCommit: beforeRelease.canCommit,
            solverMs,
          });
          renderer.endDrag();
          if (lift) renderer.settleLift(lift.liftedCells, lift.totalCells);
          refresh(true);
          if (!accepted && !hadGrab) {
            setMiss(true);
            window.setTimeout(() => setMiss(false), 420);
          }
          if (navigator.vibrate && accepted) navigator.vibrate(12);
        };

        canvas.addEventListener("pointerdown", onPointerDown);
        canvas.addEventListener("pointermove", onPointerMove, { passive: false });
        canvas.addEventListener("pointerup", finishPointer);
        canvas.addEventListener("pointercancel", finishPointer);
        canvas.addEventListener("lostpointercapture", finishPointer);

        teardown = () => {
          audio.stop();
          pendingSound.current = { progress: 0, peak: 0 };
          canvas.removeEventListener("pointerdown", onPointerDown);
          canvas.removeEventListener("pointermove", onPointerMove);
          canvas.removeEventListener("pointerup", finishPointer);
          canvas.removeEventListener("pointercancel", finishPointer);
          canvas.removeEventListener("lostpointercapture", finishPointer);
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
      if (moveToastTimer.current !== null) window.clearTimeout(moveToastTimer.current);
      textureFrame.current = 0;
      activePointer.current = null;
      teardown();
    };
  }, [level, audio, recordDiagnostic, refresh, startDiagnosticRecording]);

  const changeProfile = (profile: CurlProfile) => {
    updateSettings({ profile });
    recordDiagnostic("curl_profile", null, { profile });
    refresh(false);
  };

  const changeTearThreshold = (tearThreshold: number) => {
    updateSettings({ tearThreshold });
    simulationRef.current?.setTearThreshold(tearThreshold);
    recordDiagnostic("tension_threshold", null, { value: tearThreshold });
  };

  const changeReleaseJumpThreshold = (releaseJumpThreshold: number) => {
    updateSettings({ releaseJumpThreshold });
    simulationRef.current?.setReleaseJumpThreshold(releaseJumpThreshold);
    recordDiagnostic("area_jump_threshold", null, { value: releaseJumpThreshold });
  };

  const changeLiftedTransparency = (liftedTransparency: number) => {
    updateSettings({ liftedTransparency });
    rendererRef.current?.setLiftedTransparency(liftedTransparency);
    recordDiagnostic("lift_transparency", null, { value: liftedTransparency });
  };

  const changeTearFactor = (key: keyof TearFactors, value: number) => {
    const next = { ...settingsRef.current.tearFactors, [key]: value };
    updateSettings({ tearFactors: next });
    simulationRef.current?.setTearFactors(next);
    recordDiagnostic(`tear_factor_${key}`, null, { value });
  };

  const changeAppearance = (key: keyof PeelAppearance, value: number) => {
    const next = { ...settingsRef.current.appearance, [key]: value };
    updateSettings({ appearance: next });
    rendererRef.current?.setAppearance(next);
    recordDiagnostic("appearance", null, { key, value });
  };

  const changePeelSound = (peelSound: PeelSound) => {
    audio.stop();
    updateSettings({ peelSound });
    if (peelSound !== "off") audio.unlock();
  };

  const changeZoom = (step: number) => {
    const index = Math.max(0, Math.min(ZOOM_STEPS.length - 1, ZOOM_STEPS.indexOf(settingsRef.current.zoom) + step));
    const zoom = ZOOM_STEPS[index];
    rendererRef.current?.setZoom(zoom / 100);
    updateSettings({ zoom });
  };

  const changeCameraSettings = (camera: CameraSettings) => {
    updateSettings({ camera });
    rendererRef.current?.setCameraSettings(camera);
    recordDiagnostic("camera_settings", null, camera);
  };

  const reset = () => {
    audio.stop();
    pendingSound.current = { progress: 0, peak: 0 };
    const renderer = rendererRef.current;
    const pointerId = activePointer.current;
    activePointer.current = null;
    if (pointerId !== null && renderer?.domElement.hasPointerCapture(pointerId)) {
      renderer.domElement.releasePointerCapture(pointerId);
    }
    if (textureFrame.current) cancelAnimationFrame(textureFrame.current);
    textureFrame.current = 0;
    simulationRef.current?.reset();
    renderer?.endDrag();
    renderer?.clearReleaseAnimations();
    if (moveToastTimer.current !== null) window.clearTimeout(moveToastTimer.current);
    setMoveLimitToast(false);
    startDiagnosticRecording("level_reset");
    setMiss(false);
    refresh(true);
  };

  const buildDiagnosticLog = () => {
    const simulation = simulationRef.current;
    const renderer = rendererRef.current;
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
        curlProfile: settingsRef.current.profile,
        tensionThreshold: simulation.snapshot().tearThreshold,
        areaJumpThreshold: simulation.snapshot().releaseJumpThreshold,
        tearFactors,
        liftedTransparency,
        appearance,
        camera: { ...cameraSettings, zoom },
        peelSound,
        peelVolume,
        soundResponse,
        edgeClick,
        releaseDynamics,
      },
      environment: {
        userAgent: navigator.userAgent,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        canvasWidth: renderer?.domElement.width,
        canvasHeight: renderer?.domElement.height,
      },
      eventCount: diagnosticEvents.current.length,
      finalSnapshot: simulation.snapshot(),
      finalSolver: simulation.diagnostics(),
      stateLegend: { 0: "outside", 1: "adhered", 2: "released", 3: "lifted", 4: "torn" },
      finalStateRle: encodeStateRuns(simulation.state),
      frameTimings: renderer?.frameTimings.export(diagnosticStartedAt.current) ?? [],
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

  const clearDiagnosticLog = () => startDiagnosticRecording("manual_clear");

  const percent = Math.min(100, Math.round(snapshot.progress * 100));
  const failure = snapshot.tearFailure;
  const failureLabel = failure?.kind === "area-jump" ? "Area jump"
    : failure?.kind === "grip-gap" ? "Grip distance" : "Tension tear";
  const formatFailure = (value: number) => failure?.kind === "grip-gap"
    ? `${Math.round(value)} px` : `${(value * 100).toFixed(1)}%`;
  const failureExplanation = failure?.kind === "area-jump" ? "Too much material released at once."
    : failure?.kind === "outward" ? "Pulling back loaded the lifted flap."
    : failure?.kind === "grip-gap" ? "The pointer pulled too far from the point holding the flap."
    : "The lifted flap reached its tension limit.";
  const status = snapshot.torn
    ? snapshot.tearDragging
      ? "Level failed — move the torn piece, then let go."
      : "The lifted piece separated from the sticker."
    : snapshot.complete
    ? "Clean release — the sticker stayed intact."
      : snapshot.detached
      ? "Shape released."
      : snapshot.tracking && !snapshot.pulling
        ? "Cross an exposed edge to pick it up."
        : snapshot.pulling
          ? snapshot.frontDepth === 0 ? "Sweep from the edge into the sticker."
            : snapshot.canCommit ? "Let go to keep this peel, or keep sweeping." : "Keep sweeping the peel front."
          : snapshot.moves > 0 ? "Use the new exposed boundary for the next sweep." : "Start on an edge and sweep through the sticker.";

  const appearanceControl = (key: keyof PeelAppearance, label: string, hint?: string) => {
    const options = APPEARANCE_OPTIONS[key];
    const option = (name: string, index: number) => <option key={name} value={index}>{name}</option>;
    return (
      <label className="setting-control">
        <span>{label}</span>
        <select aria-label={label} aria-describedby={hint ? `appearance-${key}-hint` : undefined}
          value={appearance[key]} onChange={event => changeAppearance(key, Number(event.currentTarget.value))}>
          {key === "face" ? (
            <>
              {option(options[0], 0)}
              <optgroup label="Translucent">{options.slice(FIRST_REFRACTIVE_FINISH).map((name, index) => option(name, index + FIRST_REFRACTIVE_FINISH))}</optgroup>
              <optgroup label="Coatings and print">{options.slice(1, FIRST_REFRACTIVE_FINISH).map((name, index) => option(name, index + 1))}</optgroup>
            </>
          ) : options.map((name, index) => key === "released" && index === LEGACY_RIDGE_FINISH ? null : option(name, index))}
        </select>
        {hint && <small id={`appearance-${key}-hint`}>{hint}</small>}
      </label>
    );
  };

  return (
    <main className={`prototype-shell${miss ? " miss" : ""}${bottomPanelOpen ? "" : " mobile-panel-collapsed"}`}>
      <header className="prototype-header">
        <div className="header-settings" role="group" aria-label="Level settings">
          <button type="button" aria-haspopup="dialog" onClick={() => setMenu("visuals")}>Visuals</button>
          <button type="button" aria-haspopup="dialog" onClick={() => setMenu("camera-sound")}>Camera &amp; sound</button>
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
        <div role="status" className={moveLimitToast ? "move-limit-toast" : undefined}>
          {moveLimitToast ? "Move limit exceeded. Keep peeling." : null}
        </div>
        <div className="surface-glow" aria-hidden="true" />
        <div ref={hostRef} className="renderer-host" />
        {!ready && !webglError && <p className="loading-art">Preparing sticker…</p>}
        {webglError && (
          <div className="webgl-fallback" role="alert">
            <strong>Couldn’t prepare this sticker.</strong>
            <span>Choose another level or reload with WebGL enabled.</span>
          </div>
        )}
        <div id="peel-charts" className="bottom-panel-charts">
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
        </div>
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

        {menu === "physics" && (
          <SettingsDialog id="physics-settings" title="Physics" levelName={level.name} onDismiss={() => setMenu(null)}>
            <section className="settings-group" aria-label="Peel behavior">
              <h3>Peel behavior</h3>
              <label className="setting-toggle">
                <input type="checkbox" role="switch" checked={tearWarning} onChange={event => {
                  updateSettings({ tearWarning: event.currentTarget.checked });
                  refresh(false);
                }} />
                <span>Tear warning</span>
              </label>
              <label className="setting-control">
                <span>Curl profile</span>
                <select value={profile} onChange={event => changeProfile(event.currentTarget.value as CurlProfile)}>
                  <option value="cylinder">Cylinder</option>
                  <option value="cone">Cone</option>
                </select>
              </label>
              <fieldset className="fragility-settings">
                <legend>Fragility</legend>
                <FragilitySlider label="Tension" value={thresholdToSensitivity(tearThreshold, TENSION_CONTROL_MAX)}
                  onChange={value => changeTearThreshold(sensitivityToThreshold(value, TENSION_CONTROL_MAX))} />
                <FragilitySlider label="Area jump" value={thresholdToSensitivity(releaseJumpThreshold, RELEASE_JUMP_CONTROL_MAX)}
                  onChange={value => changeReleaseJumpThreshold(sensitivityToThreshold(value, RELEASE_JUMP_CONTROL_MAX))} />
                {TEAR_FACTOR_CONTROLS.map(({ key, label, hint }) => (
                  <FragilitySlider key={key} label={label} hint={hint} value={Math.round(tearFactors[key] * 100)}
                    onChange={value => changeTearFactor(key, value / 100)} />
                ))}
              </fieldset>
            </section>
            <section className="settings-group log-tools" aria-label="Diagnostic recording">
              <header><h3>Diagnostic log</h3><output>{diagnosticEvents.current.length} events</output></header>
              <p>Local only. Reproduce the issue, then export the peel events and recent frame timings.</p>
              <div className="log-actions">
                <button type="button" onClick={() => void copyDiagnosticLog()}>Copy log</button>
                <button type="button" onClick={downloadDiagnosticLog}>Download JSON</button>
                <button type="button" onClick={clearDiagnosticLog}>Clear</button>
              </div>
              <small role="status">{logStatus}</small>
            </section>
          </SettingsDialog>
        )}

        {menu === "visuals" && (
          <SettingsDialog id="visual-settings" title="Visuals" levelName={level.name} onDismiss={() => setMenu(null)}>
            <section className="settings-group" aria-label="Sticker front">
              <h3>Sticker front</h3>
              {appearanceControl("face", "Front finish")}
              {appearanceControl("sticker", "Sticker color")}
            </section>
            <section className="settings-group" aria-label="Lifted film">
              <h3>Lifted film</h3>
              {appearanceControl("back", "Back finish")}
              <label className="setting-control">
                <div><span>Lift transparency</span><output>{Math.round(liftedTransparency * 100)}%</output></div>
                <input type="range" aria-label="Lift transparency" min="5" max="90" step="1"
                  value={Math.round(liftedTransparency * 100)}
                  onChange={event => changeLiftedTransparency(Number(event.currentTarget.value) / 100)} />
                <small>Clearer film shows more of the scene through the lens.</small>
              </label>
              {appearanceControl("optics", "Optical effect")}
              {appearance.optics !== 0 && appearanceControl("filmFilter", "Optical color filter")}
            </section>
            <section className="settings-group" aria-label="Unglued areas">
              <h3>Unglued areas</h3>
              {appearanceControl("released", "Surface treatment")}
              {appearanceControl("ridge", "Raised ridge", "Lifts the unglued material above the adhesive seam.")}
              {appearanceControl("gripCurl", "Curl at previous grips", "Leaves a small curl where you held the sticker on earlier moves.")}
            </section>
            <section className="settings-group" aria-label="Surface">
              <h3>Surface</h3>
              {appearanceControl("background", "Background color")}
              {appearanceControl("glassDepth", "Glass depth", "The pane uses the selected background color.")}
            </section>
          </SettingsDialog>
        )}

        {menu === "camera-sound" && (
          <SettingsDialog id="camera-sound-settings" title="Camera & sound" levelName={level.name} onDismiss={() => setMenu(null)}>
            <section className="settings-group" aria-label="Camera">
              <h3>Camera</h3>
              <label className="setting-control">
                <span>Peel camera</span>
                <select value={cameraSettings.pan ? "pan" : "centered"}
                  onChange={event => changeCameraSettings({ ...cameraSettings, pan: event.currentTarget.value === "pan" })}>
                  <option value="pan">Pan and zoom</option>
                  <option value="centered">Centered zoom</option>
                </select>
              </label>
              <label className="setting-control">
                <div><span>Edge clearance</span><output>{cameraSettings.edgeClearance} px</output></div>
                <input type="range" aria-label="Edge clearance" min={MIN_EDGE_CLEARANCE} max={MAX_EDGE_CLEARANCE}
                  step="4" value={cameraSettings.edgeClearance}
                  onChange={event => changeCameraSettings({ ...cameraSettings, edgeClearance: Number(event.currentTarget.value) })} />
                <small>Target space between your pointer and the screen edge when the sticker comes free.</small>
              </label>
            </section>
            <section className="settings-group" aria-label="Sound">
              <h3>Sound</h3>
              <div className="peel-sound-setting">
                <label className="setting-control">
                  <span>Peel sound</span>
                  <select value={peelSound} onChange={event => changePeelSound(event.currentTarget.value as PeelSound)}>
                    {PEEL_SOUNDS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
                  </select>
                </label>
                <button type="button" disabled={peelSound === "off"} onClick={() => audio.preview(peelSound)}>Preview</button>
              </div>
              {soundDescription && <small>{soundDescription}</small>}
              <label className="setting-control">
                <span>Sound response</span>
                <select value={soundResponse} onChange={event => {
                  const soundResponse = event.currentTarget.value as PeelSoundResponse;
                  updateSettings({ soundResponse });
                  audio.setResponse(soundResponse);
                }}>
                  {PEEL_SOUND_RESPONSES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>
              <label className="setting-toggle">
                <input type="checkbox" checked={releaseDynamics} onChange={event => {
                  const releaseDynamics = event.currentTarget.checked;
                  updateSettings({ releaseDynamics });
                  audio.setReleaseDynamics(releaseDynamics);
                }} />
                <span>Louder for larger releases</span>
              </label>
              <div className="peel-sound-setting">
                <label className="setting-toggle">
                  <input type="checkbox" checked={edgeClick} onChange={event => updateSettings({ edgeClick: event.currentTarget.checked })} />
                  <span>Edge release click</span>
                </label>
                <button type="button" disabled={!edgeClick} onClick={() => { audio.unlock(); audio.playEdgeClick(); }}>Preview click</button>
              </div>
              <label className="setting-control">
                <div><span>Sound volume</span><output>{Math.round(peelVolume * 100)}%</output></div>
                <input type="range" min="0" max="100" step="1" aria-label="Sound volume"
                  value={Math.round(peelVolume * 100)}
                  onChange={event => {
                    const peelVolume = Number(event.currentTarget.value) / 100;
                    updateSettings({ peelVolume });
                    audio.setVolume(peelVolume);
                  }} />
              </label>
            </section>
          </SettingsDialog>
        )}

        {!snapshot.tracking && (snapshot.complete || snapshot.failed) && (
          <div className="result-card" role="dialog" aria-modal="false" aria-label="Level result">
            <span>{snapshot.complete ? "RELEASED" : "TORN"}</span>
            <strong>
              {snapshot.complete ? "Clean release." : "The lifted piece separated."}
            </strong>
            {failure && (
              <p className="tear-explanation">
                <b>{failureLabel}</b> reached {formatFailure(failure.value)} (limit {formatFailure(failure.threshold)}). {failureExplanation}
              </p>
            )}
            <button type="button" onClick={reset}>Try again</button>
          </div>
        )}

      </section>

      <footer id="peel-controls" className="control-bar" aria-label="Prototype settings">
        <div className="zoom-controls" role="group" aria-label="Level zoom">
          <button type="button" onClick={() => changeZoom(-1)} disabled={!ready || zoomIndex === 0} aria-label="Zoom out">−</button>
          <output aria-label="Manual zoom">{zoom}%</output>
          <button type="button" onClick={() => changeZoom(1)} disabled={!ready || zoomIndex === ZOOM_STEPS.length - 1} aria-label="Zoom in">+</button>
        </div>
        <button type="button" aria-haspopup="dialog" onClick={() => setMenu("physics")}>Physics</button>
        <button type="button" onClick={reset}>
          <span>Level</span>Reset
        </button>
        <p className="interaction-hint" aria-live="polite">{status}</p>
      </footer>
      <button
        type="button"
        className="bottom-panel-toggle"
        aria-controls="peel-controls peel-charts"
        aria-expanded={bottomPanelOpen}
        aria-label={bottomPanelOpen ? "Hide bottom panel" : "Show bottom panel"}
        onClick={() => {
          onBottomPanelChange(!bottomPanelOpen);
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
    </main>
  );
}
