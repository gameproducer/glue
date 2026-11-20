import type { Vec2 } from "../peel/PeelSimulation.ts";
import { extendStateTexture } from "./StateTexture.ts";

const bevelCells = 7;
const gripRadius = 9;
const smooth = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

export function releaseSettleDuration(liftedCells: number, totalCells: number) {
  return 500 + 500 * Math.sqrt(Math.max(0, Math.min(1, liftedCells / Math.max(1, totalCells))));
}

/** Red records release, green holds the seam bevel, and blue holds previous grip curls. */
export function writeReleaseSurface(
  target: Uint8Array, history: Uint8Array, sources: Int32Array, width: number, grips: ReadonlyMap<number, Vec2>,
) {
  const distance = new Uint8Array(history.length).fill(bevelCells);
  const queue = new Int32Array(history.length);
  let tail = 0;
  const neighbors = (index: number, visit: (neighbor: number) => void) => {
    if (index % width > 0) visit(index - 1);
    if (index % width < width - 1) visit(index + 1);
    if (index >= width) visit(index - width);
    if (index < history.length - width) visit(index + width);
  };
  target.fill(0);
  for (let index = 0; index < history.length; index++) {
    if (sources[index] !== index || !history[index]) continue;
    neighbors(index, neighbor => {
      if (sources[neighbor] !== neighbor || history[neighbor] || distance[index] === 0) return;
      distance[index] = 0;
      queue[tail++] = index;
    });
  }
  for (let head = 0; head < tail; head++) {
    const index = queue[head];
    const next = distance[index] + 1;
    if (next >= bevelCells) continue;
    neighbors(index, neighbor => {
      if (!history[neighbor] || distance[neighbor] <= next) return;
      distance[neighbor] = next;
      queue[tail++] = neighbor;
    });
  }
  for (let index = 0; index < history.length; index++) {
    if (!history[index]) continue;
    target[index * 4] = history[index];
    target[index * 4 + 1] = Math.round(smooth((distance[index] + 0.5) / bevelCells) * 255);
  }

  const height = history.length / width;
  for (const [index, inward] of grips) {
    const gx = index % width;
    const gy = Math.floor(index / width);
    for (let y = Math.max(0, gy - gripRadius); y <= Math.min(height - 1, gy + gripRadius); y++) {
      for (let x = Math.max(0, gx - gripRadius); x <= Math.min(width - 1, gx + gripRadius); x++) {
        const sample = y * width + x;
        if (!history[sample]) continue;
        const dx = x - gx;
        const dy = y - gy;
        const along = (dx * inward.x + dy * inward.y) / gripRadius;
        const radius = Math.hypot(dx, dy) / gripRadius;
        const lift = (1 - smooth(radius)) * (1 - smooth((along + 0.15) / 0.65));
        const ridge = target[sample * 4 + 1] / 255;
        const grip = Math.round(lift * ridge * 255);
        target[sample * 4 + 2] = Math.max(target[sample * 4 + 2], grip);
      }
    }
  }

  extendStateTexture(target, sources);
}
