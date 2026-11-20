import type { PeelSnapshot } from "./PeelSimulation.ts";

export const PEEL_SOUND_RESPONSES = [
  { id: "peel", label: "Peel only" },
  { id: "tension", label: "Tension + grip distance" },
] as const;
export type PeelSoundResponse = (typeof PEEL_SOUND_RESPONSES)[number]["id"];
export const DEFAULT_SOUND_RESPONSE: PeelSoundResponse = "tension";
const STORAGE_KEY = "peel.sound.response";

export function readSoundResponse(): PeelSoundResponse {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return PEEL_SOUND_RESPONSES.find(({ id }) => id === saved)?.id ?? DEFAULT_SOUND_RESPONSE;
  } catch { return DEFAULT_SOUND_RESPONSE; }
}

export function saveSoundResponse(response: PeelSoundResponse) {
  try { localStorage.setItem(STORAGE_KEY, response); } catch { /* Storage is optional. */ }
}

export const clampSoundLoad = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Each contribution is a fraction of its actual tear threshold, not raw units. */
export function peelSoundLoad(
  snapshot: Pick<PeelSnapshot, "pulling" | "torn" | "detached" | "stress" | "tearThreshold">,
  gripDistance: number | null,
  gripLimit: number,
) {
  if (!snapshot.pulling || snapshot.torn || snapshot.detached) return 0;
  const ratio = (value: number, threshold: number) => {
    if (!Number.isFinite(value) || !Number.isFinite(threshold) || value <= 0 || threshold < 0) return 0;
    return threshold === 0 ? 1 : clampSoundLoad(value / threshold);
  };
  return Math.max(ratio(snapshot.stress, snapshot.tearThreshold), gripDistance === null ? 0 : ratio(gripDistance, gripLimit));
}
