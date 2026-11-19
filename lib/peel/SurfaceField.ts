import { DataUtils } from "three";

export const SURFACE_OPTIONS = [
  ["off", "Off"], ["ridge", "Ridge"], ["diagonal", "Diagonal Ridge"],
  ["dome", "Dome"], ["bowl", "Bowl"], ["waves", "Waves"],
] as const;
export type SurfaceKind = typeof SURFACE_OPTIONS[number][0];
export const SURFACE_SIZE = 97;
export const SURFACE_MARGIN = 0.5;
const SPAN = 1 + 2 * SURFACE_MARGIN;
const STEP = SPAN / (SURFACE_SIZE - 1);
const LIFT_AXIS = 0.54;
const FLAT_OPENING = LIFT_AXIS / Math.hypot(1, LIFT_AXIS);
const clamp = (x: number, min: number, max: number) => Math.max(min, Math.min(max, x));

function taper(value: number) {
  const t = clamp((Math.abs(value) - 1) / 0.95, 0, 1);
  return 1 - t * t * (3 - 2 * t);
}

function profile(kind: SurfaceKind, x: number, y: number) {
  const central = Math.exp(-2.1 * (x * x + y * y));
  if (kind === "ridge") return Math.exp(-18 * x * x);
  if (kind === "diagonal") return Math.exp(-12 * (x - y * 0.8) ** 2);
  if (kind === "dome") return central;
  if (kind === "bowl") return -central;
  if (kind === "waves") return 0.62 * Math.sin(2.55 * Math.PI * x + 0.5 * y);
  return 0;
}

/** UV-space terrain shared by the solver, hit testing, board and sticker. Heights are in sticker-height units. */
export class SurfaceField {
  readonly pixels = new Uint16Array(SURFACE_SIZE * SURFACE_SIZE * 4);
  readonly amplitude: number;
  private readonly values = new Float32Array(SURFACE_SIZE * SURFACE_SIZE);
  readonly kind: SurfaceKind;
  readonly aspect: number;

  constructor(kind: SurfaceKind, aspect: number) {
    this.kind = kind;
    this.aspect = aspect;
    this.amplitude = 0.145 * Math.min(1, aspect);
    if (kind === "off") return;
    for (let y = 0; y < SURFACE_SIZE; y++) {
      const v = (y * STEP - SURFACE_MARGIN - 0.5) * 2;
      for (let x = 0; x < SURFACE_SIZE; x++) {
        const u = (x * STEP - SURFACE_MARGIN - 0.5) * 2;
        const index = y * SURFACE_SIZE + x;
        const envelope = taper(u) * taper(v);
        const height = envelope > 0 ? profile(kind, u, v) * envelope * this.amplitude : 0;
        this.pixels[index * 4] = DataUtils.toHalfFloat(height);
        this.values[index] = DataUtils.fromHalfFloat(this.pixels[index * 4]);
      }
    }
    for (let y = 0; y < SURFACE_SIZE; y++) {
      for (let x = 0; x < SURFACE_SIZE; x++) {
        const slope = this.gradient(x * STEP - SURFACE_MARGIN, y * STEP - SURFACE_MARGIN);
        const offset = (y * SURFACE_SIZE + x) * 4;
        this.pixels[offset + 1] = DataUtils.toHalfFloat(slope.x);
        this.pixels[offset + 2] = DataUtils.toHalfFloat(slope.y);
      }
    }
  }

  height(u: number, v: number) {
    const x = clamp((u + SURFACE_MARGIN) / STEP, 0, SURFACE_SIZE - 1);
    const y = clamp((v + SURFACE_MARGIN) / STEP, 0, SURFACE_SIZE - 1);
    const col = Math.floor(x);
    const row = Math.floor(y);
    const right = Math.min(SURFACE_SIZE - 1, col + 1);
    const above = Math.min(SURFACE_SIZE - 1, row + 1) * SURFACE_SIZE;
    const start = row * SURFACE_SIZE;
    const tx = x - col;
    const ty = y - row;
    return (this.values[start + col] * (1 - tx) + this.values[start + right] * tx) * (1 - ty)
      + (this.values[above + col] * (1 - tx) + this.values[above + right] * tx) * ty;
  }

  gradient(u: number, v: number) {
    return {
      x: (this.height(u + STEP, v) - this.height(u - STEP, v)) / (2 * STEP * this.aspect),
      y: (this.height(u, v + STEP) - this.height(u, v - STEP)) / (2 * STEP),
    };
  }
}

/** Compare opening over the local tangent with the same pull on flat material. */
export function surfaceResistance(slope: number, relativeHeight: number, reach: number) {
  const lift = clamp(LIFT_AXIS + relativeHeight / Math.max(0.12, reach), 0.14, 1.25);
  const path = Math.hypot(1, slope);
  const opening = (lift - slope) / (Math.hypot(1, lift) * path);
  return clamp(1 + 0.68 * (FLAT_OPENING - opening) + 0.25 * (path - 1), 0.68, 1.65);
}
