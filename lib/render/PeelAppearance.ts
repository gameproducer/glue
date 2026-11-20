export const FACE_FINISHES = [
  "Original", "Satin", "Pearlescent", "Brushed foil",
  "Topographic ink", "Marbled ink", "Halftone print", "Holographic foil", "Speckled enamel",
  "Hammered gold", "Engine-turned silver", "Oil-slick foil", "Cracked ice foil", "Lenticular checker foil",
  "Gloss laminate", "Soft-touch matte", "Linen laminate", "Spot UV varnish", "Dichroic laminate", "Puffy gloss",
] as const;
export const BACK_FINISHES = [
  "Clear", "Frosted", "Prismatic", "Fine mesh",
  "Amber resin", "Soap bubble", "Lenticular film", "Ripple glass", "Dew beads",
] as const;
export const RELEASE_FINISHES = ["Dimmed", "Transparent", "Frosted", "Diagonal hatch"] as const;
export const FILM_OPTICS = ["Off", "Fisheye", "Ripple lens", "Psychedelic", "Prismatic"] as const;

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
  { name: "Electric cyan", color: "#46dcff" },
  { name: "Tangerine", color: "#ff8c50" },
  { name: "Acid lime", color: "#c7f65a" },
  { name: "Ultraviolet", color: "#8767ff" },
  { name: "Smoky quartz", color: "#d2aea5" },
] as const;

export type PeelAppearance = { face: number; back: number; optics: number; released: number; background: number; sticker: number; glassDepth: number };
export const DEFAULT_APPEARANCE: PeelAppearance = { face: 0, back: 0, optics: 0, released: 0, background: 0, sticker: 0, glassDepth: 0 };
export const APPEARANCE_CONTROLS = [
  { key: "glassDepth", label: "Glass depth experiment", labels: ["Off", "On"] },
  { key: "face", label: "Front finish", labels: FACE_FINISHES },
  { key: "back", label: "Back film", labels: BACK_FINISHES },
  { key: "optics", label: "Film optics", labels: FILM_OPTICS },
  { key: "released", label: "Unglued areas", labels: RELEASE_FINISHES },
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
