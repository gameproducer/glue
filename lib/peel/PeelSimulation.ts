export const Cell = {
  outside: 0,
  adhered: 1,
  released: 2,
  lifted: 3,
  torn: 4,
} as const;

export type Vec2 = { x: number; y: number };
export type CurlProfile = "cylinder" | "cone";

export type PeelDiagnostics = {
  current: {
    totalCells: number;
    releasedCells: number;
    pendingNewCells: number;
    liftedCells: number;
    grabIndex: number;
  };
  lastStep: {
    previousPendingCells: number;
    pendingNewCells: number;
    liftedCells: number;
    gainedCells: number;
    tearCandidateCells: number;
    frontCells: number;
    averageAdhesion: number;
    pullDistance: number;
    frameDistance: number;
    elapsed: number;
    speed: number;
    targetStress: number;
    minimumPiece: number;
    avalancheTear: boolean;
    stressTear: boolean;
  };
};

export type PeelSnapshot = {
  moves: number;
  maxMoves: number;
  progress: number;
  stress: number;
  areaJump: number;
  physicsSample: number;
  tracking: boolean;
  pulling: boolean;
  canCommit: boolean;
  complete: boolean;
  failed: boolean;
  torn: boolean;
  tearDragging: boolean;
  tearThreshold: number;
  releaseJumpThreshold: number;
  tornOffset: Vec2;
  grab: Vec2;
  pointer: Vec2;
  direction: Vec2;
  frontDepth: number;
};

const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const emptyDiagnosticStep = (): PeelDiagnostics["lastStep"] => ({
  previousPendingCells: 0,
  pendingNewCells: 0,
  liftedCells: 0,
  gainedCells: 0,
  tearCandidateCells: 0,
  frontCells: 0,
  averageAdhesion: 0,
  pullDistance: 0,
  frameDistance: 0,
  elapsed: 0,
  speed: 0,
  targetStress: 0,
  minimumPiece: 0,
  avalancheTear: false,
  stressTear: false,
});

/** Connected moving-front solver based on the original Cocos2d-x GlueZone. */
export class PeelSimulation {
  readonly width: number;
  readonly height: number;
  readonly aspect: number;
  readonly state: Uint8Array;
  readonly adhesion: Float32Array;
  readonly maxMoves: number;

  private readonly initialState: Uint8Array;
  private readonly gestureBase: Uint8Array;
  private readonly tearCandidate: Uint8Array;
  private readonly grabbedComponent: Uint8Array;
  private componentAdheredCells = 0;
  private readonly visited: Uint8Array;
  private readonly queue: Int32Array;
  private totalCells = 0;
  private releasedCells = 0;
  private pendingNewCells = 0;
  private liftedCells = 0;
  private moves = 0;
  private tracking = false;
  private pulling = false;
  private failed = false;
  private torn = false;
  private tearThreshold: number;
  private releaseJumpThreshold: number;
  private tearOrigin: Vec2 = { x: 0, y: 0 };
  private tearRecoil: Vec2 = { x: 0, y: 0 };
  private tornOffset: Vec2 = { x: 0, y: 0 };
  private grabIndex = -1;
  private gestureOrigin: Vec2 = { x: 0, y: 0 };
  private grab: Vec2 = { x: 0.08, y: 0.5 };
  private pointer: Vec2 = { ...this.grab };
  private direction: Vec2 = { x: 1, y: 0 };
  private frontDepth = 0;
  private stress = 0;
  private areaJump = 0;
  private physicsSample = 0;
  private lastDiagnosticStep = emptyDiagnosticStep();
  private lastPointer: Vec2 = { ...this.grab };
  private lastTime = 0;

  constructor(
    width = 144,
    height = 132,
    seed = 0x5045454c,
    maxMoves = 4,
    mask?: Uint8Array,
    tearThreshold = 0.78,
    releaseJumpThreshold = 0.28,
  ) {
    if (mask && mask.length !== width * height) throw new Error("Sticker mask dimensions do not match the grid");
    this.width = width;
    this.height = height;
    this.aspect = width / height;
    this.maxMoves = maxMoves;
    this.tearThreshold = clamp(tearThreshold);
    this.releaseJumpThreshold = clamp(releaseJumpThreshold);
    const count = width * height;
    this.state = new Uint8Array(count);
    this.initialState = new Uint8Array(count);
    this.gestureBase = new Uint8Array(count);
    this.tearCandidate = new Uint8Array(count);
    this.grabbedComponent = new Uint8Array(count);
    this.visited = new Uint8Array(count);
    this.queue = new Int32Array(count);
    this.adhesion = new Float32Array(count);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        const present = mask ? mask[index] !== 0 : PeelSimulation.contains(x / (width - 1), y / (height - 1));
        if (present) {
          this.state[index] = Cell.adhered;
          this.totalCells++;
        }
        this.adhesion[index] = 0.22 + this.noise(x, y, seed) * 0.78;
      }
    }
    this.initialState.set(this.state);
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
    return body && !leftHole && !rightHole && !(y < -0.82 && Math.abs(x) < 0.12);
  }

  reset() {
    this.state.set(this.initialState);
    this.releasedCells = 0;
    this.pendingNewCells = 0;
    this.liftedCells = 0;
    this.moves = 0;
    this.tracking = false;
    this.pulling = false;
    this.failed = false;
    this.torn = false;
    this.tearOrigin = { x: 0, y: 0 };
    this.tearRecoil = { x: 0, y: 0 };
    this.tornOffset = { x: 0, y: 0 };
    this.grabIndex = -1;
    this.frontDepth = 0;
    this.stress = 0;
    this.areaJump = 0;
    this.physicsSample++;
    this.lastDiagnosticStep = emptyDiagnosticStep();
  }

  begin(point: Vec2, time = 0) {
    if (this.tracking || this.failed || this.torn || this.releasedCells >= this.totalCells) return false;
    this.tracking = true;
    this.pulling = false;
    this.gestureOrigin = { ...point };
    this.pointer = { ...point };
    this.lastPointer = { ...point };
    this.lastTime = time;
    this.frontDepth = 0;
    this.stress = 0;
    this.areaJump = 0;
    this.physicsSample++;
    this.lastDiagnosticStep = emptyDiagnosticStep();
    this.grabIndex = -1;
    const seed = this.nearestAccessibleCell(point);
    if (seed >= 0) this.acquire(seed);
    return true;
  }

  drag(point: Vec2, time: number) {
    if (!this.tracking) return;
    this.areaJump = 0;
    this.physicsSample++;
    this.lastDiagnosticStep = emptyDiagnosticStep();

    if (this.torn) {
      this.tornOffset = {
        x: this.tearRecoil.x + point.x - this.tearOrigin.x,
        y: this.tearRecoil.y + point.y - this.tearOrigin.y,
      };
      return;
    }

    this.pointer = { ...point };

    if (!this.pulling) {
      const seed = this.traceAccessibleCell(this.gestureOrigin, point);
      if (seed < 0) {
        this.lastPointer = { ...point };
        this.lastTime = time;
        return;
      }
      this.acquire(seed);
    }

    const dx = (point.x - this.grab.x) * this.aspect;
    const dy = point.y - this.grab.y;
    const pullDistance = Math.hypot(dx, dy);
    if (pullDistance < 0.001) return;
    this.direction = { x: dx / pullDistance, y: dy / pullDistance };
    this.frontDepth = this.calcFrontDepth(pullDistance);
    const previousPendingCells = this.pendingNewCells;
    const previousLiftedCells = this.liftedCells;
    let tearCandidateCells = 0;
    let candidateAdheredCells = 0;
    this.tearCandidate.fill(0);
    for (let index = 0; index < this.state.length; index++) {
      if (!this.grabbedComponent[index]) continue;
      const wasHeld = this.state[index] === Cell.lifted;
      const wasReleasedAtGestureStart = previousLiftedCells === 0 && this.gestureBase[index] === Cell.released;
      if (wasHeld || wasReleasedAtGestureStart) {
        this.tearCandidate[index] = 1;
        tearCandidateCells++;
        if (this.gestureBase[index] === Cell.adhered) candidateAdheredCells++;
      }
    }
    const { frontCells, averageAdhesion } = this.rebuildLifted();

    // A large one-frame expansion is a release avalanche. It is treated as a
    // fracture at the previous front, rather than allowing a small held region
    // to pull nearly the entire sticker free instantaneously.
    const gainedCells = Math.max(0, this.pendingNewCells - previousPendingCells);
    const absoluteGain = gainedCells / Math.max(1, this.totalCells);
    this.areaJump = absoluteGain;

    const frameDistance = Math.hypot((point.x - this.lastPointer.x) * this.aspect, point.y - this.lastPointer.y);
    const elapsed = this.lastTime > 0 && time > this.lastTime ? (time - this.lastTime) / 1000 : 1 / 60;
    const speed = frameDistance / Math.max(elapsed, 1 / 240);
    const narrowLoad = clamp((18 - frontCells) / 16);
    const resistanceLoad = clamp((averageAdhesion - 0.42) / 0.58);
    const reachLoad = clamp(this.frontDepth / (this.aspect * 0.78));
    const speedLoad = clamp((speed - 1.5) / 5) * 0.12;
    const targetStress = clamp(narrowLoad * 0.54 + resistanceLoad * 0.28 + reachLoad * 0.18 + speedLoad);
    this.stress += (targetStress - this.stress) * 0.2;
    this.lastPointer = { ...point };
    this.lastTime = time;

    const minimumPiece = Math.max(8, Math.round(this.totalCells * 0.002));
    const remainingAttached = this.componentAdheredCells - this.pendingNewCells;
    const minimumAnchor = Math.max(1, Math.min(minimumPiece, Math.ceil(this.componentAdheredCells * 0.015)));
    const hasAnchor = remainingAttached >= minimumAnchor;
    const avalancheTear = hasAnchor && absoluteGain >= this.releaseJumpThreshold
      && tearCandidateCells >= minimumPiece && this.componentAdheredCells - candidateAdheredCells >= minimumAnchor;
    const stressTear = hasAnchor && this.stress >= this.tearThreshold && this.liftedCells >= minimumPiece;
    this.lastDiagnosticStep = {
      previousPendingCells,
      pendingNewCells: this.pendingNewCells,
      liftedCells: this.liftedCells,
      gainedCells,
      tearCandidateCells,
      frontCells,
      averageAdhesion,
      pullDistance,
      frameDistance,
      elapsed,
      speed,
      targetStress,
      minimumPiece,
      avalancheTear,
      stressTear,
    };
    if (avalancheTear) {
      this.triggerTear(this.tearCandidate);
    } else if (stressTear) {
      this.triggerTear();
    }
  }

  end(commit = true) {
    if (!this.tracking) return false;
    if (this.torn) {
      this.tracking = false;
      this.pulling = false;
      this.failed = true;
      this.grabIndex = -1;
      return false;
    }
    const threshold = Math.max(10, Math.round(this.totalCells * 0.0015));
    const releasedWholeComponent = this.pendingNewCells > 0 && this.pendingNewCells === this.componentAdheredCells;
    const accepted = commit && this.pulling && this.frontDepth > 0.012
      && (this.pendingNewCells >= threshold || releasedWholeComponent);

    if (this.pulling) {
      for (let index = 0; index < this.state.length; index++) {
        this.state[index] = this.state[index] === Cell.lifted && accepted ? Cell.released : this.gestureBase[index];
      }
    }
    if (accepted) {
      this.releasedCells += this.pendingNewCells;
      this.moves++;
    }

    this.pendingNewCells = 0;
    this.liftedCells = 0;
    this.tracking = false;
    this.pulling = false;
    this.grabIndex = -1;
    this.frontDepth = 0;
    this.stress *= 0.32;
    this.failed = this.moves >= this.maxMoves && this.releasedCells < this.totalCells * 0.997;
    return accepted;
  }

  snapshot(): PeelSnapshot {
    const progress = (this.releasedCells + this.pendingNewCells) / Math.max(1, this.totalCells);
    return {
      moves: this.moves,
      maxMoves: this.maxMoves,
      progress,
      stress: this.stress,
      areaJump: this.areaJump,
      physicsSample: this.physicsSample,
      tracking: this.tracking,
      pulling: this.pulling,
      canCommit: this.pendingNewCells > 0,
      complete: !this.torn && progress >= 0.997,
      failed: this.failed,
      torn: this.torn,
      tearDragging: this.torn && this.tracking,
      tearThreshold: this.tearThreshold,
      releaseJumpThreshold: this.releaseJumpThreshold,
      tornOffset: { ...this.tornOffset },
      grab: { ...this.grab },
      pointer: { ...this.pointer },
      direction: { ...this.direction },
      frontDepth: this.frontDepth,
    };
  }

  diagnostics(): PeelDiagnostics {
    return {
      current: {
        totalCells: this.totalCells,
        releasedCells: this.releasedCells,
        pendingNewCells: this.pendingNewCells,
        liftedCells: this.liftedCells,
        grabIndex: this.grabIndex,
      },
      lastStep: { ...this.lastDiagnosticStep },
    };
  }

  writeTexture(target: Uint8Array) {
    if (target.length !== this.state.length * 4) throw new Error("State texture has the wrong size");
    for (let index = 0, offset = 0; index < this.state.length; index++, offset += 4) {
      const value = this.state[index];
      target[offset] = value === Cell.adhered ? 255 : 0;
      target[offset + 1] = value === Cell.released ? 255 : 0;
      target[offset + 2] = value === Cell.lifted ? 255 : 0;
      target[offset + 3] = value === Cell.torn ? 255 : 0;
    }
  }

  setTearThreshold(value: number) {
    this.tearThreshold = clamp(value);
  }

  setReleaseJumpThreshold(value: number) {
    this.releaseJumpThreshold = clamp(value);
  }

  private acquire(index: number) {
    this.grabIndex = index;
    this.grab = this.cellPoint(index);
    this.gestureBase.set(this.state);
    this.grabbedComponent.fill(0);
    this.componentAdheredCells = 0;
    this.grabbedComponent[index] = 1;
    this.queue[0] = index;
    let tail = 1;
    const visit = (next: number) => {
      if (this.grabbedComponent[next] || this.gestureBase[next] === Cell.outside) return;
      this.grabbedComponent[next] = 1;
      this.queue[tail++] = next;
    };
    for (let head = 0; head < tail; head++) {
      const cell = this.queue[head];
      const x = cell % this.width;
      if (this.gestureBase[cell] === Cell.adhered) this.componentAdheredCells++;
      if (x > 0) visit(cell - 1);
      if (x + 1 < this.width) visit(cell + 1);
      if (cell >= this.width) visit(cell - this.width);
      if (cell + this.width < this.state.length) visit(cell + this.width);
    }
    this.pulling = true;
  }

  private triggerTear(detachedMask?: Uint8Array) {
    let detachedReleasedCells = 0;
    for (let index = 0; index < this.state.length; index++) {
      const shouldDetach = detachedMask ? detachedMask[index] !== 0 : this.state[index] === Cell.lifted;
      if (shouldDetach) {
        if (this.gestureBase[index] === Cell.released) detachedReleasedCells++;
        this.state[index] = Cell.torn;
      } else {
        this.state[index] = this.gestureBase[index];
      }
    }
    this.releasedCells = Math.max(0, this.releasedCells - detachedReleasedCells);
    this.pendingNewCells = 0;
    this.liftedCells = 0;
    this.torn = true;
    this.failed = true;
    this.tearOrigin = { ...this.pointer };
    this.tearRecoil = {
      x: this.direction.x * 0.035 / this.aspect,
      y: this.direction.y * 0.035,
    };
    this.tornOffset = { ...this.tearRecoil };
    this.stress = Math.max(this.stress, this.tearThreshold);
  }

  private calcFrontDepth(pointerDistance: number) {
    const radius = 0.082;
    const quarterTravel = (Math.PI / 2 - 1) * radius;
    if (pointerDistance < quarterTravel) return pointerDistance / quarterTravel * (Math.PI / 2 * radius);
    if (pointerDistance < Math.PI * radius) {
      return ((pointerDistance - quarterTravel) / (Math.PI * radius - quarterTravel) + 1)
        * (Math.PI / 2 * radius);
    }
    return Math.PI * radius + (pointerDistance - Math.PI * radius) * 0.5;
  }

  private rebuildLifted() {
    this.state.set(this.gestureBase);
    this.visited.fill(0);
    this.pendingNewCells = 0;
    this.liftedCells = 0;
    let adhesionSum = 0;
    let frontCells = 0;
    let head = 0;
    let tail = 0;
    this.queue[tail++] = this.grabIndex;
    this.visited[this.grabIndex] = 1;

    const grabX = this.grab.x * this.aspect;
    const grabY = this.grab.y;
    const frontX = grabX + this.direction.x * this.frontDepth;
    const frontY = grabY + this.direction.y * this.frontDepth;
    const edgeTolerance = 0.7 / this.height;
    const dx4 = [-1, 1, 0, 0];
    const dy4 = [0, 0, -1, 1];

    while (head < tail) {
      const index = this.queue[head++];
      const base = this.gestureBase[index];
      if (base === Cell.outside) continue;
      const x = index % this.width;
      const y = Math.floor(index / this.width);
      const metricX = x / (this.width - 1) * this.aspect;
      const metricY = y / (this.height - 1);
      const signed = (metricX - frontX) * this.direction.x + (metricY - frontY) * this.direction.y;
      const adhesiveDelay = (this.adhesion[index] - 0.58) * 0.012;
      if (index !== this.grabIndex && signed > edgeTolerance - adhesiveDelay) continue;

      this.state[index] = Cell.lifted;
      this.liftedCells++;
      if (base === Cell.adhered) {
        this.pendingNewCells++;
        adhesionSum += this.adhesion[index];
      }

      let touchesFront = false;
      for (let neighbor = 0; neighbor < 4; neighbor++) {
        const nx = x + dx4[neighbor];
        const ny = y + dy4[neighbor];
        if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;
        const next = ny * this.width + nx;
        if (this.gestureBase[next] === Cell.outside) continue;
        const nextMetricX = nx / (this.width - 1) * this.aspect;
        const nextMetricY = ny / (this.height - 1);
        const nextSigned = (nextMetricX - frontX) * this.direction.x + (nextMetricY - frontY) * this.direction.y;
        if (nextSigned > edgeTolerance) touchesFront = true;
        if (!this.visited[next]) {
          this.visited[next] = 1;
          this.queue[tail++] = next;
        }
      }
      if (touchesFront) frontCells++;
    }

    return { frontCells, averageAdhesion: adhesionSum / Math.max(1, this.pendingNewCells) };
  }

  private traceAccessibleCell(start: Vec2, end: Vec2) {
    const spanX = Math.abs(end.x - start.x) * this.width;
    const spanY = Math.abs(end.y - start.y) * this.height;
    const steps = Math.max(1, Math.ceil(Math.max(spanX, spanY) * 2));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const x = Math.round((start.x + (end.x - start.x) * t) * (this.width - 1));
      const y = Math.round((start.y + (end.y - start.y) * t) * (this.height - 1));
      if (x < 0 || x >= this.width || y < 0 || y >= this.height) continue;
      const index = y * this.width + x;
      if (this.isAccessible(index)) return index;
    }
    return -1;
  }

  private nearestAccessibleCell(point: Vec2) {
    const centerX = Math.round(point.x * (this.width - 1));
    const centerY = Math.round(point.y * (this.height - 1));
    const radius = 4;
    let closest = -1;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let oy = -radius; oy <= radius; oy++) {
      for (let ox = -radius; ox <= radius; ox++) {
        const x = centerX + ox;
        const y = centerY + oy;
        if (x < 0 || x >= this.width || y < 0 || y >= this.height) continue;
        const distance = ox * ox + oy * oy;
        if (distance > radius * radius || distance >= closestDistance) continue;
        const index = y * this.width + x;
        if (!this.isAccessible(index)) continue;
        closest = index;
        closestDistance = distance;
      }
    }
    return closest;
  }

  private isAccessible(index: number) {
    if (this.state[index] === Cell.released) return true;
    if (this.state[index] !== Cell.adhered) return false;
    const x = index % this.width;
    const y = Math.floor(index / this.width);
    const neighbors = [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0],             [1, 0],
      [-1, 1],  [0, 1],   [1, 1],
    ];
    for (const [ox, oy] of neighbors) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) return true;
      if (this.state[ny * this.width + nx] !== Cell.adhered) return true;
    }
    return false;
  }

  private cellPoint(index: number): Vec2 {
    return { x: (index % this.width) / (this.width - 1), y: Math.floor(index / this.width) / (this.height - 1) };
  }

  private noise(x: number, y: number, seed: number) {
    let value = (Math.imul(x + 17, 374761393) + Math.imul(y + 31, 668265263) + seed) | 0;
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    value ^= value >>> 16;
    const fine = (value >>> 0) / 4294967295;
    const broad = Math.sin(x * 0.14 + y * 0.09) * Math.sin(y * 0.12 - x * 0.05) * 0.5 + 0.5;
    return fine * 0.38 + broad * 0.62;
  }
}
