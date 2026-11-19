import { DataUtils } from "three";
import type { Vec2 } from "../peel/PeelSimulation";

const SEAM_CURL_SCALE = 1.25;
const MAX_PLANAR_LENGTH_RATIO = 1.16;
const NEIGHBOR_STEPS = [[-1, 0], [0, -1], [-1, -1], [1, -1]] as const;

export function attachedCurlDepth(depth: number, cellsFromSeam: number, cellSize: number) {
  return Math.min(depth, Math.max(0, cellsFromSeam - 1) * cellSize * SEAM_CURL_SCALE);
}

function curlShift(depth: number, radius: number) {
  const halfTurn = Math.PI * radius;
  return depth >= halfTurn ? 2 * depth - halfTurn : depth - radius * Math.sin(depth / radius);
}

function depthForShift(shift: number, depth: number, radius: number) {
  if (shift <= 0) return 0;
  const halfTurn = Math.PI * radius;
  if (shift >= halfTurn) return (shift + halfTurn) / 2;

  let low = 0;
  let high = Math.min(depth, halfTurn);
  for (let i = 0; i < 12; i++) {
    const middle = (low + high) * 0.5;
    if (curlShift(middle, radius) > shift) high = middle;
    else low = middle;
  }
  return low;
}

function pinnedCorrection(depth: number) {
  const encoded = DataUtils.toHalfFloat(depth);
  return DataUtils.fromHalfFloat(encoded) < depth ? encoded + 1 : encoded;
}

/** Shapes one curl while keeping the glued seam pinned and limiting in-plane stretch. */
export class AttachedCurl {
  readonly pixels: Uint16Array;
  private readonly depths: Float32Array;
  private readonly nominalDepths: Float32Array;
  private readonly radii: Float32Array;
  private readonly shifts: Float32Array;
  private readonly cells: Int32Array;
  private readonly width: number;
  private readonly height: number;
  private readonly stepX: number;
  private readonly stepY: number;
  private readonly sources: Int32Array;

  constructor(
    width: number,
    height: number,
    stickerWidth: number,
    stickerHeight: number,
    sources: Int32Array,
  ) {
    const size = width * height;
    this.width = width;
    this.height = height;
    this.sources = sources;
    this.stepX = stickerWidth / width;
    this.stepY = stickerHeight / height;
    this.pixels = new Uint16Array(size);
    this.depths = new Float32Array(size);
    this.nominalDepths = new Float32Array(size);
    this.radii = new Float32Array(size);
    this.shifts = new Float32Array(size);
    this.cells = new Int32Array(size);
  }

  update(state: Uint8Array, seam: Uint8Array, grab: Vec2, direction: Vec2, depth: number, radius: number, cone: boolean) {
    const { width, height, stepX, stepY, sources, cells, depths, nominalDepths, radii, shifts, pixels } = this;
    const cellSize = Math.min(stepX, stepY);
    shifts.fill(Infinity);
    pixels.fill(0);
    let count = 0;
    for (let i = 0; i < seam.length; i++) {
      if (sources[i] !== i) continue;
      const x = (i % width + 0.5 - width / 2) * stepX - grab.x;
      const y = (Math.floor(i / width) + 0.5 - height / 2) * stepY - grab.y;
      const along = x * direction.x + y * direction.y;
      const nominal = Math.max(0, depth - along);
      if (!state[i * 4 + 2]) {
        // Keep the flat side of the feathered join at its original position.
        pixels[i] = pinnedCorrection(nominal);
        continue;
      }
      const lateral = y * direction.x - x * direction.y;
      const localRadius = cone ? Math.max(0.12, radius * Math.max(0.58, Math.min(1.46, 1 + lateral * 0.24))) : radius;
      const q = attachedCurlDepth(nominal, seam[i], cellSize);
      cells[count++] = i;
      depths[i] = q;
      nominalDepths[i] = nominal;
      radii[i] = localRadius;
      shifts[i] = curlShift(q, localRadius);
    }

    // The component across the drag stays fixed. Solve for how much additional
    // travel along the drag each neighboring edge can absorb without stretching.
    const stencil = (sign: number) => NEIGHBOR_STEPS.map(([x, y]) => {
      const dx = x * sign;
      const dy = y * sign;
      const length = Math.hypot(dx * stepX, dy * stepY);
      const along = dx * stepX * direction.x + dy * stepY * direction.y;
      const allowance = Math.sqrt((MAX_PLANAR_LENGTH_RATIO ** 2 - 1) * length ** 2 + along ** 2) + along;
      return { dx, offset: dx + dy * width, diagonal: dx !== 0 && dy !== 0, allowance };
    });
    const forward = stencil(1);
    const backward = stencil(-1);
    // Alternating sweeps carry the seam's limits around bends without a per-frame heap.
    for (let pass = 0; pass < 4; pass++) {
      const relaxedForward = this.relax(count, forward, 1);
      const relaxedBackward = this.relax(count, backward, -1);
      if (!relaxedForward && !relaxedBackward) break;
    }

    for (let j = 0; j < count; j++) {
      const i = cells[j];
      const q = depths[i];
      const lowShift = shifts[i];
      const limited = lowShift + 0.00001 < curlShift(q, radii[i]) ? depthForShift(lowShift, q, radii[i]) : q;
      depths[i] = Math.max(0, nominalDepths[i] - limited);
    }
    // Smooth only the correction to the cylindrical arc. Smoothing the arc
    // itself changes its slope along the artwork edge where neighbors are missing.
    for (let j = 0; j < count; j++) {
      const i = cells[j];
      let sum = depths[i] * 4;
      let weight = 4;
      if (seam[i] > 2) {
        const col = i % width;
        if (col > 0 && shifts[i - 1] !== Infinity) { sum += depths[i - 1]; weight++; }
        if (col < width - 1 && shifts[i + 1] !== Infinity) { sum += depths[i + 1]; weight++; }
        if (i >= width && shifts[i - width] !== Infinity) { sum += depths[i - width]; weight++; }
        if (i + width < shifts.length && shifts[i + width] !== Infinity) { sum += depths[i + width]; weight++; }
      }
      pixels[i] = seam[i] <= 1 ? pinnedCorrection(depths[i]) : DataUtils.toHalfFloat(sum / weight);
    }
    // Extend the correction into the artwork fringe. The shader evaluates the
    // nominal arc at the actual vertex, so curved outlines keep a smooth bend.
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      if (source < 0 || source === i) continue;
      pixels[i] = pixels[source];
    }
  }

  private relax(count: number, stencil: Array<{ dx: number; offset: number; diagonal: boolean; allowance: number }>, step: 1 | -1) {
    const { width, shifts, cells } = this;
    let changed = false;
    for (let j = step > 0 ? 0 : count - 1; j >= 0 && j < count; j += step) {
      const i = cells[j];
      const col = i % width;
      let limit = shifts[i];
      for (const { dx, offset, diagonal, allowance } of stencil) {
        const neighbor = i + offset;
        if (col + dx < 0 || col + dx >= width || neighbor < 0 || neighbor >= shifts.length) continue;
        // Diagonals may cross a material corner, but cannot bridge a hole.
        if (diagonal && shifts[i + dx] === Infinity && shifts[neighbor - dx] === Infinity) continue;
        limit = Math.min(limit, shifts[neighbor] + allowance);
      }
      if (limit < shifts[i] - 0.00001) {
        shifts[i] = limit;
        changed = true;
      }
    }
    return changed;
  }

  sampleDepth(uv: Vec2, nominalDepth: number) {
    const { width, height, pixels } = this;
    const x = Math.max(0, Math.min(width - 1, uv.x * width - 0.5));
    const y = Math.max(0, Math.min(height - 1, uv.y * height - 0.5));
    const col = Math.floor(x);
    const row = Math.floor(y);
    const right = Math.min(col + 1, width - 1);
    const above = Math.min(row + 1, height - 1);
    const tx = x - col;
    const ty = y - row;
    const depth = (column: number, line: number) => DataUtils.fromHalfFloat(pixels[line * width + column]);
    const low = depth(col, row) * (1 - tx) + depth(right, row) * tx;
    const high = depth(col, above) * (1 - tx) + depth(right, above) * tx;
    return Math.max(0, nominalDepth - (low * (1 - ty) + high * ty));
  }
}
