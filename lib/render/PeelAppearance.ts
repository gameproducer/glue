export const FACE_FINISHES = ["Original", "Satin", "Pearlescent", "Brushed foil"] as const;
export const BACK_FINISHES = ["Clear", "Frosted", "Prismatic", "Fine mesh"] as const;

export const BACKGROUNDS = [
  { name: "Graphite", color: "#25222b" },
  { name: "Midnight blue", color: "#203959" },
  { name: "Forest", color: "#23443b" },
  { name: "Burgundy", color: "#532e40" },
  { name: "Warm clay", color: "#735443" },
] as const;

export const STICKER_COLORS = [
  { name: "Original", color: null },
  { name: "White", color: "#ffffff" },
  { name: "Mint", color: "#99f4d3" },
  { name: "Rose", color: "#ff90b7" },
  { name: "Lavender", color: "#c1adff" },
  { name: "Gold", color: "#ffd27a" },
] as const;

export type PeelAppearance = { face: number; back: number; background: number; sticker: number };
export const DEFAULT_APPEARANCE: PeelAppearance = { face: 0, back: 0, background: 0, sticker: 0 };
export const APPEARANCE_CONTROLS = [
  { key: "face", label: "Front finish", labels: FACE_FINISHES },
  { key: "back", label: "Back film", labels: BACK_FINISHES },
  { key: "background", label: "Background", labels: BACKGROUNDS.map(({ name }) => name) },
  { key: "sticker", label: "Sticker color", labels: STICKER_COLORS.map(({ name }) => name) },
] as const;

export const APPEARANCE_STORAGE_KEY = "peel.appearance";

export function readAppearance(): PeelAppearance {
  const appearance = { ...DEFAULT_APPEARANCE };
  try {
    const saved = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}");
    for (const { key, labels } of APPEARANCE_CONTROLS) {
      const value = saved?.[key];
      if (Number.isInteger(value) && value >= 0 && value < labels.length) appearance[key] = value;
    }
  } catch { /* The defaults also work when storage is unavailable. */ }
  return appearance;
}
