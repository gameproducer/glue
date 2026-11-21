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
const bounded = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;

export function readLevelSettings(id: string): LevelSettings {
  const defaults = DEFAULT_LEVEL_SETTINGS;
  const key = levelKey(id);
  const readLegacy = (field: string) => {
    try {
      const value = localStorage.getItem(`${key}.${field}`);
      return value === null || value.trim() === "" ? undefined : Number(value);
    } catch { return undefined; }
  };
  let saved: Partial<LevelSettings> | null = null;
  try {
    const value = JSON.parse(localStorage.getItem(`${key}.settings`) ?? "null");
    if (value && typeof value === "object" && !Array.isArray(value)) saved = value;
  } catch { /* Use legacy preferences. */ }
  const legacyCamera = saved ? defaults.camera : readCameraSettings();
  return {
    profile: saved?.profile === "cone" ? "cone" : defaults.profile,
    tearThreshold: bounded(saved?.tearThreshold ?? readLegacy("tearThreshold"), defaults.tearThreshold, 0, TENSION_CONTROL_MAX),
    releaseJumpThreshold: bounded(saved?.releaseJumpThreshold ?? readLegacy("releaseJumpThreshold"),
      defaults.releaseJumpThreshold, 0, RELEASE_JUMP_CONTROL_MAX),
    tearFactors: {
      outward: bounded(saved?.tearFactors?.outward ?? readLegacy("tearFactors.outward"), defaults.tearFactors.outward, 0, 1),
      bottleneck: bounded(saved?.tearFactors?.bottleneck ?? readLegacy("tearFactors.bottleneck"), defaults.tearFactors.bottleneck, 0, 1),
    },
    tearWarning: typeof saved?.tearWarning === "boolean" ? saved.tearWarning : defaults.tearWarning,
    liftedTransparency: bounded(saved?.liftedTransparency ?? readLegacy("liftedTransparency"), defaults.liftedTransparency, 0.05, 0.9),
    appearance: saved ? normalizeAppearance(saved.appearance) : readAppearance(),
    camera: {
      pan: typeof saved?.camera?.pan === "boolean" ? saved.camera.pan : legacyCamera.pan,
      edgeClearance: bounded(saved?.camera?.edgeClearance, legacyCamera.edgeClearance, MIN_EDGE_CLEARANCE, MAX_EDGE_CLEARANCE),
    },
    zoom: typeof saved?.zoom === "number" && ZOOM_STEPS.includes(saved.zoom) ? saved.zoom : defaults.zoom,
    peelSound: saved ? PEEL_SOUNDS.find(({ id: sound }) => sound === saved.peelSound)?.id ?? defaults.peelSound : readPeelSound(),
    peelVolume: saved ? bounded(saved.peelVolume, defaults.peelVolume, 0, 1) : readPeelVolume(),
    soundResponse: saved
      ? PEEL_SOUND_RESPONSES.find(({ id: response }) => response === saved.soundResponse)?.id ?? defaults.soundResponse
      : readSoundResponse(),
    edgeClick: typeof saved?.edgeClick === "boolean" ? saved.edgeClick : defaults.edgeClick,
    releaseDynamics: typeof saved?.releaseDynamics === "boolean" ? saved.releaseDynamics : defaults.releaseDynamics,
  };
}

export function saveLevelSettings(id: string, settings: LevelSettings) {
  try { localStorage.setItem(`${levelKey(id)}.settings`, JSON.stringify(settings)); } catch { /* Storage is optional. */ }
}
