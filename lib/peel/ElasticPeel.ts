import type { Vec2 } from "./PeelSimulation";
import { Cell } from "./PeelCells.ts";

/**
 * A quasi-static spring approximation. Rings of material between the seam and
 * grip act in series. A ring with a smaller cross section takes more strain.
 * The displacement field is also consumed by the renderer.
 */
export class ElasticPeel {
  readonly weights: Uint8Array;
  readonly displacement: Vec2 = { x: 0, y: 0 };
  private readonly distances: Uint16Array;
  private readonly traction: Uint8Array;
  private readonly queue: Int32Array;
  private readonly widths: Uint32Array;
  private readonly compliance: Float32Array;
  private readonly width: number;
  private readonly height: number;
  private active = 0;
  private softness = 1;
  private peakWeightDelta = 0;
  reach = 0;
  reaction = 0;
  peakStrain = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.weights = new Uint8Array(width * height);
    this.distances = new Uint16Array(width * height);
    this.traction = new Uint8Array(width * height);
    this.queue = new Int32Array(width * height);
    this.widths = new Uint32Array(width * height + 1);
    this.compliance = new Float32Array(this.widths.length);
  }

  reset() {
    this.weights.fill(0);
    this.traction.fill(0);
    this.active = 0;
    this.softness = 1;
    this.peakWeightDelta = 0;
    this.reach = 0;
    this.reaction = 0;
    this.peakStrain = 0;
    this.displacement.x = this.displacement.y = 0;
  }

  advance(requested: number, elasticity: number, adhesive: number, resistance: number) {
    const compliance = Math.max(Number.EPSILON, elasticity * (0.056 + 0.043 * this.softness));
    const yieldLoad = (0.24 + 0.62 * adhesive) * resistance;
    // Establish a small tab before the plate can carry tension.
    const tab = Math.min(requested, 1.6 / this.height);
    this.reach = Math.min(requested, Math.max(this.reach, tab));
    const load = (requested - this.reach) / compliance;
    this.reaction = Math.max(0, load);
    if (load > yieldLoad) this.reach = requested - yieldLoad * compliance;
    return this.reach;
  }

  contactDelay(index: number, direction: Vec2) {
    if (!this.active) return 0;
    const { width, traction } = this;
    const col = index % width;
    // Only springs coming from the lifted side can load this bond.
    const left = col > 0 ? traction[index - 1] : 0;
    const right = col < width - 1 ? traction[index + 1] : 0;
    const down = traction[index - width] ?? 0;
    const up = traction[index + width] ?? 0;
    const projected = Math.max(
      left * (0.55 + 0.45 * direction.x), right * (0.55 - 0.45 * direction.x),
      down * (0.55 + 0.45 * direction.y), up * (0.55 - 0.45 * direction.y),
    );
    if (!projected) return 0;
    const strain = projected / 255 * Math.hypot(this.displacement.x, this.displacement.y) * this.height;
    return 0.018 * Math.max(-0.5, Math.min(1, 0.5 - strain - 0.25 * this.reaction));
  }

  rebuild(state: Uint8Array, grip: number) {
    const { width, weights, traction, distances, queue, widths, compliance } = this;
    this.active = 0;
    this.peakWeightDelta = 0;
    weights.fill(0);
    traction.fill(0);
    distances.fill(0);
    let tail = 0;
    const flat = (i: number) => state[i] === Cell.adhered || state[i] === Cell.released;
    for (let i = 0; i < state.length; i++) {
      if (state[i] !== Cell.lifted) continue;
      const col = i % width;
      if ((col > 0 && flat(i - 1)) || (col < width - 1 && flat(i + 1))
        || flat(i - width) || flat(i + width)) {
        distances[i] = 1;
        queue[tail++] = i;
      }
    }
    const visit = (i: number, distance: number) => {
      if (state[i] !== Cell.lifted || distances[i]) return;
      distances[i] = distance;
      queue[tail++] = i;
    };
    let deepest = 0;
    for (let head = 0; head < tail; head++) {
      const i = queue[head];
      const col = i % width;
      const distance = distances[i];
      deepest = Math.max(deepest, distance);
      if (col > 0) visit(i - 1, distance + 1);
      if (col < width - 1) visit(i + 1, distance + 1);
      visit(i - width, distance + 1);
      visit(i + width, distance + 1);
    }
    if (distances[grip] < 2) return;

    widths.fill(0, 0, deepest + 1);
    for (let j = 0; j < tail; j++) widths[distances[queue[j]]]++;
    const meanWidth = tail / deepest;
    for (let d = 1; d <= deepest; d++) {
      // Bound the relative compliance of a one-cell tip or neck.
      const local = Math.max(0.48, Math.min(2.8, Math.sqrt(meanWidth / widths[d])));
      compliance[d] = compliance[d - 1] + local;
    }
    const gripDistance = distances[grip] - 1;
    this.softness = compliance[gripDistance] / gripDistance;
    for (let j = 0; j < tail; j++) {
      const i = queue[j];
      weights[i] = Math.round(255 * Math.min(1, compliance[distances[i] - 1] / compliance[gripDistance]));
    }
    for (let j = 0; j < tail; j++) {
      const i = queue[j];
      const col = i % width;
      const weight = weights[i];
      const right = col < width - 1 && distances[i + 1] ? Math.abs(weight - weights[i + 1]) : 0;
      const up = distances[i + width] ? Math.abs(weight - weights[i + width]) : 0;
      if (distances[i] === 1) {
        const left = col > 0 ? weights[i - 1] : 0;
        traction[i] = Math.max(left, right, weights[i - width] ?? 0, up);
      }
      this.peakWeightDelta = Math.max(this.peakWeightDelta, right, up);
    }
    this.active = tail;
  }

  deform(dx: number, dy: number, inward: Vec2, elasticity: number) {
    const extension = Math.max(0, dx * inward.x + dy * inward.y - this.reach);
    const lateral = dx * -inward.y + dy * inward.x;
    const shear = Math.max(-0.056 * elasticity, Math.min(0.056 * elasticity, lateral * 0.35 * elasticity));
    const axial = Math.min(extension, elasticity * 0.15);
    this.displacement.x = (inward.x * axial - inward.y * shear) * Number(this.active > 0);
    this.displacement.y = (inward.y * axial + inward.x * shear) * Number(this.active > 0);
    this.peakStrain = this.peakWeightDelta / 255 * Math.hypot(this.displacement.x, this.displacement.y) * (this.height - 1);
  }
}
