import { DEFAULT_PEEL_VOLUME, PEEL_SOUNDS, readPeelSound, readPeelVolume, type PeelSound } from "./PeelAudio.ts";
import { DEFAULT_SOUND_RESPONSE, PEEL_SOUND_RESPONSES, readSoundResponse, type PeelSoundResponse } from "./PeelSoundResponse.ts";
import type { CurlProfile, TearFactors } from "./PeelSimulation.ts";
import { DEFAULT_APPEARANCE, normalizeAppearance, readAppearance, type PeelAppearance } from "../render/PeelAppearance.ts";
import { DEFAULT_CAMERA_SETTINGS, MAX_EDGE_CLEARANCE, MIN_EDGE_CLEARANCE, readCameraSettings, type CameraSettings } from "../render/PeelFraming.ts";

export const ZOOM_STEPS = [60, 75, 90, 100, 108, 115];
export const TENSION_CONTROL_MAX = 0.66;
export const RELEASE_JUMP_CONTROL_MAX = 0.66;

export function thresholdToSensitivity(threshold: number, maxThreshold: number) {
  return Math.round((1 - threshold / maxThreshold) * 100);
}

export function sensitivityToThreshold(sensitivity: number, maxThreshold: number) {
  return maxThreshold * (1 - sensitivity / 100);
}

export type LevelSettings = {
  profile: CurlProfile;
  tearThreshold: number;
  releaseJumpThreshold: number;
  tearFactors: TearFactors;
  tearWarning: boolean;
  liftedTransparency: number;
  appearance: PeelAppearance;
  camera: CameraSettings;
  zoom: number;
  peelSound: PeelSound;
  peelVolume: number;
  soundResponse: PeelSoundResponse;
  edgeClick: boolean;
  releaseDynamics: boolean;
};

export const DEFAULT_LEVEL_SETTINGS: LevelSettings = {
  profile: "cylinder",
  tearThreshold: 0.40,
  releaseJumpThreshold: 0.15,
  tearFactors: { outward: 0.05, bottleneck: 0.05 },
  tearWarning: true,
  liftedTransparency: 0.5,
  appearance: DEFAULT_APPEARANCE,
  camera: DEFAULT_CAMERA_SETTINGS,
  zoom: 100,
  peelSound: "off",
  peelVolume: DEFAULT_PEEL_VOLUME,
  soundResponse: DEFAULT_SOUND_RESPONSE,
  edgeClick: true,
  releaseDynamics: false,
};

const levelKey = (id: string) => `peel.level.${id}`;
const SELECTION_KEY = "peel.selectedLevel";
const bounded = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;

type SavedLevelSettings = Omit<Partial<LevelSettings>, "tearFactors"> & { tearFactors?: Partial<TearFactors> };

function settingsObject(value: unknown): SavedLevelSettings | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeLevelSettings(saved: SavedLevelSettings): LevelSettings {
  const defaults = DEFAULT_LEVEL_SETTINGS;
  return {
    profile: saved.profile === "cone" ? "cone" : defaults.profile,
    tearThreshold: bounded(saved.tearThreshold, defaults.tearThreshold, 0, TENSION_CONTROL_MAX),
    releaseJumpThreshold: bounded(saved.releaseJumpThreshold, defaults.releaseJumpThreshold, 0, RELEASE_JUMP_CONTROL_MAX),
    tearFactors: {
      outward: bounded(saved.tearFactors?.outward, defaults.tearFactors.outward, 0, 1),
      bottleneck: bounded(saved.tearFactors?.bottleneck, defaults.tearFactors.bottleneck, 0, 1),
    },
    tearWarning: typeof saved.tearWarning === "boolean" ? saved.tearWarning : defaults.tearWarning,
    liftedTransparency: bounded(saved.liftedTransparency, defaults.liftedTransparency, 0.05, 0.9),
    appearance: normalizeAppearance(saved.appearance),
    camera: {
      pan: typeof saved.camera?.pan === "boolean" ? saved.camera.pan : defaults.camera.pan,
      edgeClearance: bounded(saved.camera?.edgeClearance, defaults.camera.edgeClearance, MIN_EDGE_CLEARANCE, MAX_EDGE_CLEARANCE),
    },
    zoom: typeof saved.zoom === "number" && ZOOM_STEPS.includes(saved.zoom) ? saved.zoom : defaults.zoom,
    peelSound: PEEL_SOUNDS.find(({ id: sound }) => sound === saved.peelSound)?.id ?? defaults.peelSound,
    peelVolume: bounded(saved.peelVolume, defaults.peelVolume, 0, 1),
    soundResponse: PEEL_SOUND_RESPONSES.find(({ id: response }) => response === saved.soundResponse)?.id ?? defaults.soundResponse,
    edgeClick: typeof saved.edgeClick === "boolean" ? saved.edgeClick : defaults.edgeClick,
    releaseDynamics: typeof saved.releaseDynamics === "boolean" ? saved.releaseDynamics : defaults.releaseDynamics,
  };
}

export function readLevelSettings(id: string, previous?: LevelSettings): LevelSettings {
  const key = levelKey(id);
  let saved: SavedLevelSettings | null = null;
  try {
    saved = settingsObject(JSON.parse(localStorage.getItem(`${key}.settings`) ?? "null"));
  } catch { /* Use legacy preferences. */ }

  const readLegacy = (field: string, min: number, max: number) => {
    try {
      const value = localStorage.getItem(`${key}.${field}`);
      if (!value?.trim()) return undefined;
      const parsed = bounded(Number(value), NaN, min, max);
      return Number.isFinite(parsed) ? parsed : undefined;
    } catch { return undefined; }
  };
  const tearThreshold = saved?.tearThreshold ?? readLegacy("tearThreshold", 0, TENSION_CONTROL_MAX);
  const releaseJumpThreshold = saved?.releaseJumpThreshold ?? readLegacy("releaseJumpThreshold", 0, RELEASE_JUMP_CONTROL_MAX);
  const outward = saved?.tearFactors?.outward ?? readLegacy("tearFactors.outward", 0, 1);
  const bottleneck = saved?.tearFactors?.bottleneck ?? readLegacy("tearFactors.bottleneck", 0, 1);
  const liftedTransparency = saved?.liftedTransparency ?? readLegacy("liftedTransparency", 0.05, 0.9);
  const local = { tearThreshold, releaseJumpThreshold, tearFactors: { outward, bottleneck }, liftedTransparency };
  if (saved) return normalizeLevelSettings({ ...saved, ...local });
  if (previous && [tearThreshold, releaseJumpThreshold, outward, bottleneck, liftedTransparency].every(value => value === undefined)) {
    return previous;
  }
  return normalizeLevelSettings({
    ...local,
    appearance: readAppearance(), camera: readCameraSettings(), peelSound: readPeelSound(), peelVolume: readPeelVolume(),
    soundResponse: readSoundResponse(),
  });
}

export function saveLevelSettings(id: string, settings: LevelSettings) {
  try { localStorage.setItem(`${levelKey(id)}.settings`, JSON.stringify(settings)); } catch { /* Storage is optional. */ }
}

export function readLevelSelection(): { id: string; previous?: LevelSettings } | null {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (!raw) return null;
    if (!raw.startsWith("{")) return { id: raw };
    const saved = JSON.parse(raw);
    if (typeof saved?.id !== "string") return null;
    const previous = settingsObject(saved.previous);
    return { id: saved.id, previous: previous ? normalizeLevelSettings(previous) : undefined };
  } catch { return null; }
}

export function saveLevelSelection(id: string, previous: LevelSettings) {
  try { localStorage.setItem(SELECTION_KEY, JSON.stringify({ id, previous })); } catch { /* Storage is optional. */ }
}
