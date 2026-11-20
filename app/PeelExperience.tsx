"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CurlProfile,
  type PeelDiagnostics,
  PeelSimulation,
  type PeelSnapshot,
  type TearFactors,
  type Vec2,
} from "@/lib/peel/PeelSimulation";
import { loadStickerAsset } from "@/lib/peel/StickerAsset";
import { DEFAULT_PEEL_VOLUME, PEEL_SOUNDS, PeelAudio, readPeelSound, readPeelVolume, savePeelSound, savePeelVolume, type PeelSound } from "@/lib/peel/PeelAudio";
import { APPEARANCE_CONTROLS, APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE, readAppearance, type PeelAppearance } from "@/lib/render/PeelAppearance";
import { PeelRenderer } from "@/lib/render/PeelRenderer";
import stickerLevels from "@/lib/peel/levels.json";

const DEFAULT_LEVEL = {
  pack: "Prototype",
  maxMoves: 4,
  id: "octopus-v1",
  name: "Octopus",
  artwork: "/octopus-sticker.webp",
  tearThreshold: 0.40,
  releaseJumpThreshold: 0.15,
  liftedTransparency: 0.5,
} as const;
const ZOOM_STEPS = [60, 75, 90, 100, 115, 135, 160];
const TENSION_CONTROL_MAX = 0.66;
const RELEASE_JUMP_CONTROL_MAX = 0.66;
// A screen-space cap tuned to roughly 1.5 cm on an iPhone at normal page scale.
const GRIP_GAP_LIMIT_PX = 84;
const DEFAULT_TEAR_FACTORS: TearFactors = { outward: 0.05, bottleneck: 0.05 };
const TEAR_FACTOR_CONTROLS = [
  { key: "outward", label: "Outward pull", hint: "How easily a lifted flap tears when pulled back." },
  { key: "bottleneck", label: "Thin neck", hint: "How strongly a constriction between wider sections adds tension." },
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
  const tearThresholdStorageKey = `peel.level.${level.id}.tearThreshold`;
  const releaseJumpStorageKey = `peel.level.${level.id}.releaseJumpThreshold`;
  const liftedTransparencyStorageKey = `peel.level.${level.id}.liftedTransparency`;
  const tearFactorsStorageKey = `peel.level.${level.id}.tearFactors`;
  const levelIndex = LEVELS.findIndex(item => item.id === level.id);
  const hostRef = useRef<HTMLDivElement>(null);
  const simulationRef = useRef<PeelSimulation | null>(null);
  const rendererRef = useRef<PeelRenderer | null>(null);
  const activePointer = useRef<number | null>(null);
  const textureFrame = useRef(0);
  const moveToastTimer = useRef<number | null>(null);
  const profileRef = useRef<CurlProfile>("cylinder");
  const diagnosticEvents = useRef<DiagnosticEvent[]>([]);
  const diagnosticStartedAt = useRef(0);
  const diagnosticStartedWallClock = useRef("");
  const diagnosticSessionId = useRef("");
  const [profile, setProfile] = useState<CurlProfile>("cylinder");
  const [debug, setDebug] = useState(false);
  const [menu, setMenu] = useState<"physics" | "visuals" | null>(null);
  const menuRef = useRef<HTMLElement>(null);
  const [appearance, setAppearance] = useState(DEFAULT_APPEARANCE);
  const [peelSound, setPeelSound] = useState<PeelSound>("off");
  const [peelVolume, setPeelVolume] = useState(DEFAULT_PEEL_VOLUME);
  const peelSoundRef = useRef<PeelSound>("off");
  const [tearThreshold, setTearThreshold] = useState<number>(DEFAULT_LEVEL.tearThreshold);
  const [releaseJumpThreshold, setReleaseJumpThreshold] = useState<number>(DEFAULT_LEVEL.releaseJumpThreshold);
  const [liftedTransparency, setLiftedTransparency] = useState<number>(DEFAULT_LEVEL.liftedTransparency);
  const [tearFactors, setTearFactors] = useState(DEFAULT_TEAR_FACTORS);
  const [zoomIndex, setZoomIndex] = useState(ZOOM_STEPS.indexOf(100));
  const [fps, setFps] = useState(60);
  const [ready, setReady] = useState(false);
  const [miss, setMiss] = useState(false);
  const [webglError, setWebglError] = useState(false);
  const [snapshot, setSnapshot] = useState<PeelSnapshot>(emptySnapshot);
  const [moveLimitToast, setMoveLimitToast] = useState(false);
  const [logStatus, setLogStatus] = useState("Recording locally");

  useEffect(() => {
    const saved = readPeelSound();
    peelSoundRef.current = saved;
    setPeelSound(saved);
    const volume = readPeelVolume();
    setPeelVolume(volume);
    audio.setVolume(volume);
    audio.setMuted(saved === "off");
  }, [audio]);

  useEffect(() => {
    if (!menu) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || menuRef.current?.contains(target) || target.closest("[data-settings-trigger]")) return;
      setMenu(null);
      if (hostRef.current?.contains(target)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    return () => document.removeEventListener("pointerdown", dismissOutside, true);
  }, [menu]);

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

  const refresh = useCallback((updateTexture = true, checkGrip = false) => {
    const simulation = simulationRef.current;
    const renderer = rendererRef.current;
    if (!simulation) return;
    let next = simulation.snapshot();
    const textureStarted = performance.now();
    if (updateTexture) renderer?.updateState();
    if (checkGrip && renderer) {
      const gapPx = renderer.gripGap(next, profileRef.current);
      if (gapPx !== null && gapPx > GRIP_GAP_LIMIT_PX / 4) {
        const tore = simulation.applyGripGap(gapPx, GRIP_GAP_LIMIT_PX,
          gapPx >= GRIP_GAP_LIMIT_PX ? renderer.tornGripContact() : null);
        if (tore) {
          renderer.updateDragReach();
          renderer.updateState();
          if (navigator.vibrate) navigator.vibrate([22, 34, 28]);
        }
        next = simulation.snapshot();
        recordDiagnostic("grip_gap", next.pointer, { gapPx, limitPx: GRIP_GAP_LIMIT_PX });
      }
    }
    const poseStarted = performance.now();
    renderer?.setPeel(
      next.grab,
      next.direction,
      next.frontDepth,
      profileRef.current,
      next.stress,
      next.tearThreshold,
      next.tornOffset,
      next.torn,
      next.detached ? next.pointer : undefined,
    );
    renderer?.frameTimings.recordState(poseStarted - textureStarted, performance.now() - poseStarted);
    setSnapshot(next);
  }, [recordDiagnostic]);

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
        const savedTearFactors = { ...DEFAULT_TEAR_FACTORS };
        try {
          savedThreshold = readSavedSetting(tearThresholdStorageKey, savedThreshold, 0, TENSION_CONTROL_MAX);
          savedJumpThreshold = readSavedSetting(releaseJumpStorageKey, savedJumpThreshold, 0, RELEASE_JUMP_CONTROL_MAX);
          savedTransparency = readSavedSetting(liftedTransparencyStorageKey, savedTransparency, 0.05, 0.9);
          for (const { key } of TEAR_FACTOR_CONTROLS) {
            savedTearFactors[key] = readSavedSetting(`${tearFactorsStorageKey}.${key}`, savedTearFactors[key], 0, 1);
          }
        } catch {
          // Storage can be unavailable in locked-down browser contexts; the level default remains valid.
        }
        setTearThreshold(savedThreshold);
        setReleaseJumpThreshold(savedJumpThreshold);
        setLiftedTransparency(savedTransparency);
        setTearFactors(savedTearFactors);
        const simulation = new PeelSimulation(
          asset.width,
          asset.height,
          0x5045454c,
          level.maxMoves,
          asset.mask,
          savedThreshold,
          savedJumpThreshold,
        );
        simulation.setTearFactors(savedTearFactors);
        const renderer = new PeelRenderer(hostRef.current, simulation, asset.image, asset.aspect, level.artwork.startsWith("/stickers/"));
        renderer.setLiftedTransparency(savedTransparency);
        const savedAppearance = readAppearance();
        renderer.setAppearance(savedAppearance);
        setAppearance(savedAppearance);
        simulationRef.current = simulation;
        rendererRef.current = renderer;
        startDiagnosticRecording("level_load");
        renderer.onFps = setFps;
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
          if (peelSoundRef.current !== "off") audio.unlock();
          audio.beginGesture();
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
          simulation.drag(point, simulationTime);
          const solverMs = performance.now() - simulationTime;
          renderer.updateDragReach();
          renderer.frameTimings.recordInput(solverMs);
          recordDiagnostic("pointer_move", point, {
            simulationTime,
            solverMs,
            pointerId: event.pointerId,
          });
          const next = simulation.snapshot();
          if (!next.torn && !next.outwardPulling) {
            audio.playProgress(peelSoundRef.current, next.progress - before.progress);
          }
          scheduleTextureRefresh();
          if (!before.torn && next.torn && navigator.vibrate) navigator.vibrate([22, 34, 28]);
        };

        const finishPointer = (event: PointerEvent) => {
          if (activePointer.current !== event.pointerId) return;
          if (textureFrame.current) {
            cancelAnimationFrame(textureFrame.current);
            textureFrame.current = 0;
            refresh(true, true);
          }
          const releasedByPlayer = event.type === "pointerup";
          if (releasedByPlayer && peelSoundRef.current !== "off") audio.unlock();
          activePointer.current = null;
          if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
          const beforeRelease = simulation.snapshot();
          const hadGrab = beforeRelease.pulling;
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
          const point = releasedByPlayer ? renderer.dragToSticker(event.clientX, event.clientY) : beforeRelease.pointer;
          recordDiagnostic(releasedByPlayer ? "pointer_up" : "pointer_cancel", point, {
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
  }, [level, audio, recordDiagnostic, refresh, startDiagnosticRecording, tearThresholdStorageKey, releaseJumpStorageKey, liftedTransparencyStorageKey, tearFactorsStorageKey]);

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

  const changeTearFactor = (key: keyof TearFactors, value: number) => {
    const next = { ...tearFactors, [key]: value };
    setTearFactors(next);
    simulationRef.current?.setTearFactors(next);
    recordDiagnostic(`tear_factor_${key}`, null, { value });
    try {
      window.localStorage.setItem(`${tearFactorsStorageKey}.${key}`, value.toFixed(2));
    } catch {
      // The setting remains active for this session when persistent storage is unavailable.
    }
  };

  const changeAppearance = (key: keyof PeelAppearance, value: number) => {
    const next = { ...appearance, [key]: value };
    setAppearance(next);
    rendererRef.current?.setAppearance(next);
    recordDiagnostic("appearance", null, { key, value });
    try { localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(next)); } catch { /* Storage is optional. */ }
  };

  const changePeelSound = (sound: PeelSound) => {
    peelSoundRef.current = sound;
    setPeelSound(sound);
    if (sound !== "off") audio.unlock();
    audio.setMuted(sound === "off");
    savePeelSound(sound);
  };

  const changeZoom = (step: number) => {
    const index = Math.max(0, Math.min(ZOOM_STEPS.length - 1, zoomIndex + step));
    rendererRef.current?.setZoom(ZOOM_STEPS[index] / 100);
    setZoomIndex(index);
  };

  const reset = () => {
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
    renderer?.clearDissolves();
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
        curlProfile: profileRef.current,
        tensionThreshold: simulation.snapshot().tearThreshold,
        areaJumpThreshold: simulation.snapshot().releaseJumpThreshold,
        tearFactors,
        liftedTransparency,
        appearance,
        peelSound,
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
          ? snapshot.outwardPulling ? "Pulling back loads the lifted edge toward a tear."
            : snapshot.frontDepth === 0 ? "Sweep from the edge into the sticker."
            : snapshot.stress > tearThreshold * 0.86 ? "The material is necking — change direction."
            : snapshot.canCommit ? "Let go to keep this peel, or keep sweeping." : "Keep sweeping the peel front."
          : snapshot.moves > 0 ? "Use the new exposed boundary for the next sweep." : "Start on an edge and sweep through the sticker.";

  return (
    <main className={`prototype-shell${miss ? " miss" : ""}${bottomPanelOpen ? "" : " mobile-panel-collapsed"}`}>
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
        <p className="interaction-hint" aria-live="polite">{status}</p>

        {menu === "physics" && (
          <aside ref={menuRef} className="physics-settings" aria-label="Level material settings">
            <label className="setting-control">
              <div><span>Tension tear</span><output>{Math.round(tearThreshold * 100)}%</output></div>
              <input
                type="range"
                min="0"
                max={Math.round(TENSION_CONTROL_MAX * 100)}
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
                max={Math.round(RELEASE_JUMP_CONTROL_MAX * 100)}
                step="1"
                value={Math.round(releaseJumpThreshold * 100)}
                onChange={(event) => changeReleaseJumpThreshold(Number(event.currentTarget.value) / 100)}
              />
            </label>
            {TEAR_FACTOR_CONTROLS.map(({ key, label, hint }) => (
              <label key={key} className="setting-control" title={hint}>
                <div><span>{label}</span><output>{tearFactors[key] === 0 ? "Off" : `${Math.round(tearFactors[key] * 100)}%`}</output></div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  aria-label={label}
                  aria-valuetext={tearFactors[key] === 0 ? "Off" : `${Math.round(tearFactors[key] * 100)} percent`}
                  value={Math.round(tearFactors[key] * 100)}
                  onChange={(event) => changeTearFactor(key, Number(event.currentTarget.value) / 100)}
                />
              </label>
            ))}
            <small>Autosaved for {level.name}</small>
            <section className="log-tools" aria-label="Diagnostic recording">
              <header><span>Diagnostic log</span><output>{diagnosticEvents.current.length} events</output></header>
              <p>Local only. Reproduce the issue, then export the peel events and recent frame timings.</p>
              <div className="log-actions">
                <button type="button" onClick={() => void copyDiagnosticLog()}>Copy log</button>
                <button type="button" onClick={downloadDiagnosticLog}>Download JSON</button>
                <button type="button" onClick={clearDiagnosticLog}>Clear</button>
              </div>
              <small role="status">{logStatus}</small>
            </section>
          </aside>
        )}

        {menu === "visuals" && (
          <aside ref={menuRef} className="physics-settings visual-settings" aria-label="Visual settings">
            <div className="peel-sound-setting">
              <label className="setting-control">
                <span>Peel sound</span>
                <select value={peelSound} onChange={event => changePeelSound(event.currentTarget.value as PeelSound)}>
                  {PEEL_SOUNDS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>
              <button type="button" disabled={peelSound === "off"} onClick={() => audio.preview(peelSound)}>Preview</button>
            </div>
            <label className="setting-control">
              <div><span>Sound volume</span><output>{Math.round(peelVolume * 100)}%</output></div>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                aria-label="Sound volume"
                value={Math.round(peelVolume * 100)}
                onChange={event => {
                  const volume = Number(event.currentTarget.value) / 100;
                  setPeelVolume(volume);
                  audio.setVolume(volume);
                  savePeelVolume(volume);
                }}
              />
            </label>
            {APPEARANCE_CONTROLS.map(({ key, label, labels }) => (
              <label key={key} className="setting-control">
                <span>{label}</span>
                <select value={appearance[key]} onChange={event => changeAppearance(key, Number(event.currentTarget.value))}>
                  {labels.map((name, index) => <option value={index} key={name}>{name}</option>)}
                </select>
              </label>
            ))}
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
          </aside>
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

      <footer id="peel-controls" className="control-bar" aria-label="Prototype settings">
        <div className="zoom-controls" role="group" aria-label="Level zoom">
          <button type="button" onClick={() => changeZoom(-1)} disabled={!ready || zoomIndex === 0} aria-label="Zoom out">−</button>
          <output aria-label="Manual zoom">{ZOOM_STEPS[zoomIndex]}%</output>
          <button type="button" onClick={() => changeZoom(1)} disabled={!ready || zoomIndex === ZOOM_STEPS.length - 1} aria-label="Zoom in">+</button>
        </div>
        <button type="button" onClick={toggleProfile} aria-label={`Curl profile: ${profile}`}>
          <span>Curl</span>{profile}
        </button>
        <button type="button" onClick={toggleDebug} aria-pressed={debug}>
          <span>Debug</span>{debug ? "On" : "Off"}
        </button>
        <button type="button" data-settings-trigger onClick={() => setMenu(current => current === "physics" ? null : "physics")} aria-expanded={menu === "physics"}>
          <span>Physics</span>Tune
        </button>
        <button type="button" data-settings-trigger onClick={() => setMenu(current => current === "visuals" ? null : "visuals")} aria-expanded={menu === "visuals"}>
          <span>Visuals</span>Style
        </button>
        <button type="button" onClick={reset}>
          <span>Level</span>Reset
        </button>
      </footer>
      <button
        type="button"
        className="bottom-panel-toggle"
        aria-controls="peel-controls peel-charts"
        aria-expanded={bottomPanelOpen}
        aria-label={bottomPanelOpen ? "Hide bottom panel" : "Show bottom panel"}
        onClick={() => {
          if (bottomPanelOpen) setMenu(null);
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
