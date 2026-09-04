export const Cell = {
  outside: 0,
  adhered: 1,
  released: 2,
  lifted: 3,
} as const;

export type Vec2 = { x: number; y: number };
export type CurlProfile = "cylinder" | "cone";

export type PeelSnapshot = {
  moves: number;
  maxMoves: number;
  progress: number;
  stress: number;
  pulling: boolean;
  canCommit: boolean;
  complete: boolean;
  failed: boolean;
  grab: Vec2;
  pointer: Vec2;
  inward: Vec2;
  peelDepth: number;
};

class MinHeap {
  private indices: number[] = [];
  private priorities: number[] = [];

  get isEmpty() { return this.indices.length === 0; }

  push(index: number, priority: number) {
    let i = this.indices.length;
    this.indices.push(index);
    this.priorities.push(priority);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.priorities[p] <= priority) break;
      this.indices[i] = this.indices[p];
      this.priorities[i] = this.priorities[p];
      i = p;
    }
    this.indices[i] = index;
    this.priorities[i] = priority;
  }

  pop(): [number, number] {
    const index = this.indices[0];
    const priority = this.priorities[0];
    const lastIndex = this.indices.pop()!;
    const lastPriority = this.priorities.pop()!;
    if (this.indices.length > 0) {
      let i = 0;
      while (true) {
        const left = i * 2 + 1;
        if (left >= this.indices.length) break;
        const right = left + 1;
        const child = right < this.indices.length && this.priorities[right] < this.priorities[left] ? right : left;
        if (this.priorities[child] >= lastPriority) break;
        this.indices[i] = this.indices[child];
        this.priorities[i] = this.priorities[child];
        i = child;
      }
      this.indices[i] = lastIndex;
      this.priorities[i] = lastPriority;
    }
    return [index, priority];
  }
}

const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));

/** Deterministic adhesive-grid simulation. Rendering never feeds back into this state. */
export class PeelSimulation {
  readonly width: number;
  readonly height: number;
  readonly state: Uint8Array;
  readonly adhesion: Float32Array;
  readonly arrival: Float32Array;
  readonly maxMoves: number;

  private totalCells = 0;
  private movedCells = 0;
  private liftedCells = 0;
  private moves = 0;
  private pulling = false;
  private failed = false;
  private grab: Vec2 = { x: 0.86, y: 0.5 };
  private pointer: Vec2 = { ...this.grab };
  private inward: Vec2 = { x: -1, y: 0 };
  private peelDepth = 0;
  private stress = 0;
  private lastPointer: Vec2 = { ...this.grab };
  private lastTime = 0;

  constructor(width = 144, height = 132, seed = 0x5045454c, maxMoves = 4) {
    this.width = width;
    this.height = height;
    this.maxMoves = maxMoves;
    const count = width * height;
    this.state = new Uint8Array(count);
    this.adhesion = new Float32Array(count);
    this.arrival = new Float32Array(count);
    this.arrival.fill(Infinity);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const u = x / (width - 1);
        const v = y / (height - 1);
        const i = y * width + x;
        if (PeelSimulation.contains(u, v)) {
          this.state[i] = Cell.adhered;
          this.totalCells++;
        }
        this.adhesion[i] = 0.2 + this.noise(x, y, seed) * 0.8;
      }
    }
  }

  static contains(u: number, v: number) {
    const x = (u - 0.5) * 2;
    const y = (v - 0.5) * 2;
    const ellipse = (cx: number, cy: number, rx: number, ry: number) => {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      return dx * dx + dy * dy <= 1;
    };
    const body = ellipse(-0.38, 0.32, 0.62, 0.59)
      || ellipse(0.38, 0.32, 0.62, 0.59)
      || ellipse(-0.36, -0.32, 0.57, 0.59)
      || ellipse(0.36, -0.32, 0.57, 0.59)
      || ellipse(0, 0, 0.39, 0.9);
    const leftHole = ellipse(-0.35, 0.28, 0.115, 0.17);
    const rightHole = ellipse(0.35, 0.28, 0.115, 0.17);
    const lowerNotch = y < -0.82 && Math.abs(x) < 0.12;
    return body && !leftHole && !rightHole && !lowerNotch;
  }

  reset() {
    this.movedCells = 0;
    this.liftedCells = 0;
    this.moves = 0;
    this.pulling = false;
    this.failed = false;
    this.peelDepth = 0;
    this.stress = 0;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = y * this.width + x;
        this.state[i] = PeelSimulation.contains(x / (this.width - 1), y / (this.height - 1)) ? Cell.adhered : Cell.outside;
      }
    }
  }

  begin(point: Vec2, time = 0) {
    if (this.pulling || this.failed || this.movedCells === this.totalCells) return false;
    const seed = this.nearestExposed(point, 0.15);
    if (seed < 0) return false;
    this.grab = this.cellPoint(seed);
    this.pointer = { ...point };
    this.lastPointer = { ...point };
    this.lastTime = time;
    this.peelDepth = 0;
    this.stress = 0;
    this.pulling = true;
    this.computeArrival(seed);
    return true;
  }

  drag(point: Vec2, time: number) {
    if (!this.pulling) return;
    this.pointer = { ...point };
    const dx = point.x - this.grab.x;
    const dy = point.y - this.grab.y;
    const pull = Math.hypot(dx, dy);
    if (pull > 0.004) this.inward = { x: -dx / pull, y: -dy / pull };

    const depthCells = pull * Math.max(this.width, this.height) * 1.02;
    this.peelDepth = depthCells / Math.max(this.width, this.height);
    let lifted = 0;
    for (let i = 0; i < this.state.length; i++) {
      if (this.state[i] === Cell.adhered && this.arrival[i] <= depthCells) {
        this.state[i] = Cell.lifted;
      } else if (this.state[i] === Cell.lifted && this.arrival[i] > depthCells) {
        this.state[i] = Cell.adhered;
      }
      if (this.state[i] === Cell.lifted) lifted++;
    }
    this.liftedCells = lifted;

    if (this.lastTime > 0 && time > this.lastTime) {
      const frameDistance = Math.hypot(point.x - this.lastPointer.x, point.y - this.lastPointer.y);
      const speed = frameDistance / ((time - this.lastTime) / 1000);
      const speedLoad = clamp((speed - 0.45) / 2.8);
      const areaLoad = clamp(lifted / Math.max(1, this.totalCells) * 0.7);
      this.stress += (Math.max(speedLoad, areaLoad) - this.stress) * 0.22;
    }
    this.lastPointer = { ...point };
    this.lastTime = time;
  }

  end(commit = true) {
    if (!this.pulling) return false;
    const accepted = commit && this.liftedCells >= 8 && this.peelDepth > 0.035;
    for (let i = 0; i < this.state.length; i++) {
      if (this.state[i] !== Cell.lifted) continue;
      this.state[i] = accepted ? Cell.released : Cell.adhered;
    }
    if (accepted) {
      this.movedCells += this.liftedCells;
      this.moves++;
    }
    this.liftedCells = 0;
    this.pulling = false;
    this.peelDepth = 0;
    this.stress *= 0.35;
    this.failed = this.moves >= this.maxMoves && this.movedCells < this.totalCells;
    return accepted;
  }

  snapshot(): PeelSnapshot {
    const progress = (this.movedCells + this.liftedCells) / Math.max(1, this.totalCells);
    return {
      moves: this.moves,
      maxMoves: this.maxMoves,
      progress,
      stress: this.stress,
      pulling: this.pulling,
      canCommit: this.liftedCells >= 8,
      complete: progress >= 0.999,
      failed: this.failed,
      grab: { ...this.grab },
      pointer: { ...this.pointer },
      inward: { ...this.inward },
      peelDepth: this.peelDepth,
    };
  }

  writeTexture(target: Uint8Array) {
    if (target.length !== this.state.length * 4) throw new Error("State texture has the wrong size");
    for (let i = 0, p = 0; i < this.state.length; i++, p += 4) {
      const value = this.state[i];
      target[p] = value === Cell.adhered ? 255 : 0;
      target[p + 1] = value === Cell.released ? 255 : 0;
      target[p + 2] = value === Cell.lifted ? 255 : 0;
      target[p + 3] = value === Cell.outside ? 0 : 255;
    }
  }

  private noise(x: number, y: number, seed: number) {
    let n = (Math.imul(x + 17, 374761393) + Math.imul(y + 31, 668265263) + seed) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    const fine = (n >>> 0) / 4294967295;
    const broad = Math.sin(x * 0.14 + y * 0.09) * Math.sin(y * 0.12 - x * 0.05) * 0.5 + 0.5;
    return fine * 0.38 + broad * 0.62;
  }

  private cellPoint(index: number): Vec2 {
    return { x: (index % this.width) / (this.width - 1), y: Math.floor(index / this.width) / (this.height - 1) };
  }

  private isExposed(index: number) {
    if (this.state[index] !== Cell.adhered) return false;
    const x = index % this.width;
    const y = Math.floor(index / this.width);
    const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [ox, oy] of neighbors) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) return true;
      if (this.state[ny * this.width + nx] !== Cell.adhered) return true;
    }
    return false;
  }

  private nearestExposed(point: Vec2, radius: number) {
    let best = -1;
    let bestDistance = radius * radius;
    for (let i = 0; i < this.state.length; i++) {
      if (!this.isExposed(i)) continue;
      const cell = this.cellPoint(i);
      const dx = cell.x - point.x;
      const dy = cell.y - point.y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  }

  private computeArrival(seed: number) {
    this.arrival.fill(Infinity);
    this.arrival[seed] = 0;
    const heap = new MinHeap();
    heap.push(seed, 0);
    const neighbors = [
      [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
      [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, 1, Math.SQRT2],
    ] as const;
    while (!heap.isEmpty) {
      const [index, distance] = heap.pop();
      // Arrival is compact Float32 data while heap priorities are JS doubles.
      // Compare with a small tolerance so quantization does not stop propagation.
      if (distance > this.arrival[index] + 0.0001) continue;
      const x = index % this.width;
      const y = Math.floor(index / this.width);
      for (const [ox, oy, step] of neighbors) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;
        const next = ny * this.width + nx;
        if (this.state[next] !== Cell.adhered) continue;
        const resistance = 0.72 + (this.adhesion[index] + this.adhesion[next]) * 0.34;
        const candidate = distance + step * resistance;
        if (candidate >= this.arrival[next]) continue;
        this.arrival[next] = candidate;
        heap.push(next, candidate);
      }
    }
  }
}
