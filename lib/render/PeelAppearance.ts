export const FACE_FINISHES = [
  "Original", "Satin", "Pearlescent", "Brushed foil",
  "Topographic ink", "Marbled ink", "Halftone print", "Holographic foil", "Speckled enamel",
  "Hammered gold", "Engine-turned silver", "Oil-slick foil", "Cracked ice foil", "Lenticular checker foil",
  "Gloss laminate", "Soft-touch matte", "Linen laminate", "Spot UV varnish", "Dichroic laminate", "Puffy gloss",
  "Jelly", "Glass", "Liquid glass", "Water", "Clear tape", "Security hologram", "Caramel",
] as const;
export const BACK_FINISHES = [
  "Clear", "Frosted", "Prismatic", "Fine mesh",
  "Amber resin", "Soap bubble", "Lenticular film", "Ripple glass", "Dew beads",
] as const;
export const RELEASE_FINISHES = ["Dimmed", "Transparent", "Frosted", "Diagonal hatch", "Raised ridge", "Keep artwork"] as const;
export const FILM_OPTICS = ["Off", "Fisheye", "Ripple lens", "Psychedelic", "Prismatic"] as const;
export const FILM_FILTERS = [
  { name: "Neutral", color: 0xffffff },
  { name: "Ice blue", color: 0x9cdcff },
  { name: "Deep blue", color: 0x728dff },
  { name: "Rose", color: 0xff92bf },
  { name: "Amber", color: 0xffba70 },
  { name: "Smoke", color: 0x98919c },
] as const;
export const PUFFY_FINISH = 19;
export const FIRST_REFRACTIVE_FINISH = 20;
export const CLEAR_TAPE_FINISH = 24;
export const SECURITY_HOLOGRAM_FINISH = 25;
export const CARAMEL_FINISH = 26;
export const usesTranslucentCoating = (finish: number) => finish === CLEAR_TAPE_FINISH || finish === CARAMEL_FINISH;
export const usesFrontRefraction = (finish: number) =>
  (finish >= FIRST_REFRACTIVE_FINISH && finish < CLEAR_TAPE_FINISH) || usesTranslucentCoating(finish);
export const LEGACY_RIDGE_FINISH = 4;
const KEEP_ARTWORK_FINISH = 5;

export const BACKGROUNDS = [
  { name: "Graphite", color: "#25222b" },
  { name: "Midnight blue", color: "#203959" },
  { name: "Forest", color: "#23443b" },
  { name: "Burgundy", color: "#532e40" },
  { name: "Warm clay", color: "#735443" },
  { name: "Glacier blue", color: "#538ec3" },
  { name: "Slate gray", color: "#717783" },
  { name: "Pearl white", color: "#e3e6ed" },
  { name: "Black", color: "#000000", plain: true },
  { name: "White", color: "#ffffff", plain: true, light: true },
  { name: "Warm white", color: "#f4efe6", plain: true, light: true },
  { name: "Dark blue", color: "#101e39" },
] as const;

export const SPACE = { original: 0, glass: 1, darkroom: 2, paper: 3, lightbox: 4 } as const;
export const SURFACE_TEXTURE = { original: 0, grain: 1, paper: 2 } as const;

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
  { name: "Black", color: "#000000" },
] as const;

export const APPEARANCE_OPTIONS = {
  face: FACE_FINISHES,
  sticker: STICKER_COLORS.map(({ name }) => name),
  back: BACK_FINISHES,
  optics: FILM_OPTICS,
  filmFilter: FILM_FILTERS.map(({ name }) => name),
  released: RELEASE_FINISHES,
  ridge: ["Off", "On"],
  gripCurl: ["Off", "On"],
  background: BACKGROUNDS.map(({ name }) => name),
  space: ["Original", "Glass Depth", "Darkroom", "Paper Studio", "Lightbox"],
  surfaceTexture: ["Original", "Fine grain", "Paper"],
  shadow: ["Automatic", "Off", "On"],
  keepCrease: ["Off", "On"],
} as const;
export type PeelAppearance = Record<keyof typeof APPEARANCE_OPTIONS, number>;
export const DEFAULT_APPEARANCE: PeelAppearance = {
  face: 3, sticker: 0, back: 0, optics: 0, filmFilter: 0, released: 1,
  ridge: 0, gripCurl: 1, background: 11, space: SPACE.original, surfaceTexture: SURFACE_TEXTURE.original,
  shadow: 0, keepCrease: 0,
};

export function shadowVisible({ shadow, space }: PeelAppearance) {
  return shadow === 2 || (shadow === 0 && (space === SPACE.glass || space === SPACE.paper));
}

export const APPEARANCE_STORAGE_KEY = "peel.appearance";

export function normalizeAppearance(saved: unknown, defaults = DEFAULT_APPEARANCE): PeelAppearance {
  const appearance = { ...defaults };
  if (typeof saved !== "object" || saved === null) return appearance;
  const { glassDepth } = saved as { glassDepth?: unknown };
  if (glassDepth === 1) appearance.space = SPACE.glass;
  else if (glassDepth === 0) appearance.space = SPACE.original;
  for (const key of Object.keys(APPEARANCE_OPTIONS) as (keyof PeelAppearance)[]) {
    const value = (saved as Partial<PeelAppearance>)[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < APPEARANCE_OPTIONS[key].length) {
      appearance[key] = value;
    }
  }
  if (appearance.released === LEGACY_RIDGE_FINISH) {
    appearance.released = KEEP_ARTWORK_FINISH;
    appearance.ridge = 1;
  }
  return appearance;
}

export function readAppearance(): PeelAppearance {
  try {
    return normalizeAppearance(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}"));
  } catch { return { ...DEFAULT_APPEARANCE }; }
}
