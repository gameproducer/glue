export const Cell = {
  outside: 0,
  adhered: 1,
  released: 2,
  lifted: 3,
  torn: 4,
} as const;

export type Vec2 = { x: number; y: number };
export type CurlProfile = "cylinder" | "cone";
export type TearFactors = { outward: number; bottleneck: number };
export type TearFailure = {
  kind: "tension" | "area-jump" | "outward" | "grip-gap";
  value: number;
  threshold: number;
};

const OUTWARD_DEAD_ZONE = 0.018;
const OUTWARD_LOAD_DISTANCE = 0.18;
const PEEL_HALF_TURN = Math.PI * 0.082;
const PEEL_QUARTER_TURN = PEEL_HALF_TURN / 2;
const PEEL_QUARTER_TRAVEL = PEEL_QUARTER_TURN - 0.082;
const FRONT_PROPAGATION_RATIO = 6;
const MINIMUM_TEAR_FOOTPRINT = 0.003;
const LOCAL_NECK_MAX_WIDTH = 8;

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
    outwardTear: boolean;
    bottleneckLoad: number;
    tearCandidateMs?: number;
    frontRebuildMs?: number;
    bottleneckMs?: number;
    tornPreviouslyReleasedCells?: number;
    carriedReleasedCells?: number;
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
  outwardPulling: boolean;
  canCommit: boolean;
  detached: boolean;
  complete: boolean;
  failed: boolean;
  tearFailure: TearFailure | null;
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
  outwardTear: false,
  bottleneckLoad: 0,
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
  private readonly releasedHistory: Uint8Array;
  private readonly previousGrips = new Map<number, Vec2>();
  private readonly gestureBase: Uint8Array;
  private readonly tearCandidate: Uint8Array;
  private readonly grabbedComponent: Uint8Array;
  private readonly componentExterior: Uint8Array;
  private exteriorReady = false;
  private readonly sectionWidths: Uint32Array;
  private readonly minimumTearPiece: number;
  private componentAdheredCells = 0;
  private readonly componentBounds = { left: 0, right: 0, bottom: 0, top: 0 };
  private shortFrontWeight = 0.54;
  private readonly visited: Uint8Array;
  private readonly queue: Int32Array;
  private readonly nextFrontWave: Int32Array;
  private totalCells = 0;
  private releasedCells = 0;
  private releasedHistoryRevision = 0;
  private pendingNewCells = 0;
  private liftedCells = 0;
  private moves = 0;
  private moveEarned = false;
  private tracking = false;
  private pulling = false;
  private outwardPulling = false;
  private heldReach = 0;
  private heldStress = 0;
  private outwardSeconds = 0;
  private strainTravel = 0;
  private failed = false;
  private tearFailure: TearFailure | null = null;
  private torn = false;
  private tearThreshold: number;
  private releaseJumpThreshold: number;
  private tearFactors: TearFactors = { outward: 0, bottleneck: 0 };
  private tearOrigin: Vec2 = { x: 0, y: 0 };
  private tearRecoil: Vec2 = { x: 0, y: 0 };
  private tornOffset: Vec2 = { x: 0, y: 0 };
  private grabIndex = -1;
  private gestureOrigin: Vec2 = { x: 0, y: 0 };
  private pullOrigin: Vec2 = { x: 0, y: 0 };
  private inward: Vec2 = { x: 0, y: 0 };
  private grab: Vec2 = { x: 0.08, y: 0.5 };
  private pointer: Vec2 = { ...this.grab };
  private direction: Vec2 = { x: 1, y: 0 };
  private frontDepth = 0;
  private stress = 0;
  private warningLoad = 0;
  private warningDirection: Vec2 | null = null;
  private areaJump = 0;
  private edgeCueSent = false;
  private frontTravelRemainder = 0;
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
    this.minimumTearPiece = Math.max(8, Math.ceil(count * MINIMUM_TEAR_FOOTPRINT));
    this.state = new Uint8Array(count);
    this.initialState = new Uint8Array(count);
    this.releasedHistory = new Uint8Array(count);
    this.gestureBase = new Uint8Array(count);
    this.tearCandidate = new Uint8Array(count);
    this.grabbedComponent = new Uint8Array(count);
    this.componentExterior = new Uint8Array(count);
    this.sectionWidths = new Uint32Array(2 * Math.ceil(Math.hypot(width, height)) + 1);
    this.visited = new Uint8Array(count);
    this.queue = new Int32Array(count);
    this.nextFrontWave = new Int32Array(count);
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
    this.releasedHistory.fill(0);
    this.previousGrips.clear();
    this.releasedHistoryRevision++;
    this.releasedCells = 0;
    this.pendingNewCells = 0;
    this.liftedCells = 0;
    this.moves = 0;
    this.moveEarned = false;
    this.tracking = false;
    this.pulling = false;
    this.outwardPulling = false;
    this.failed = false;
    this.tearFailure = null;
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
    this.moveEarned = false;
    this.pulling = false;
    this.outwardPulling = false;
    this.edgeCueSent = false;
    this.heldReach = 0;
    this.heldStress = 0;
    this.outwardSeconds = 0;
    this.strainTravel = 0;
    this.gestureOrigin = { ...point };
    this.frontTravelRemainder = 0;
    this.pointer = { ...point };
    this.lastPointer = { ...point };
    this.lastTime = time;
    this.frontDepth = 0;
    this.stress = 0;
    this.warningLoad = 0;
    this.warningDirection = null;
    this.areaJump = 0;
    this.physicsSample++;
    this.lastDiagnosticStep = emptyDiagnosticStep();
    this.grabIndex = -1;
    const seed = this.nearestAccessibleCell(point);
    if (seed >= 0) this.acquire(seed, point);
    return true;
  }

  drag(point: Vec2, time: number) {
    if (!this.tracking) return;
    this.warningLoad = 0;
    this.warningDirection = null;
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
    if (this.detached) return;

    if (!this.pulling) {
      const seed = this.traceAccessibleCell(this.gestureOrigin, point);
      if (seed < 0) {
        this.lastPointer = { ...point };
        this.lastTime = time;
        return;
      }
      this.acquire(seed, this.cellPoint(seed));
    }

    const dx = (point.x - this.grab.x) * this.aspect;
    const dy = point.y - this.grab.y;
    const pullDistance = Math.hypot(dx, dy);
    const travelX = (point.x - this.pullOrigin.x) * this.aspect;
    const travelY = point.y - this.pullOrigin.y;
    const travel = Math.hypot(travelX, travelY);
    const inward = this.inward.x || this.inward.y ? this.inward : this.inwardAlongThinStroke(dx, dy, pullDistance);
    const inwardDistance = dx * inward.x + dy * inward.y;
    const inwardTravel = travelX * inward.x + travelY * inward.y;
    const minimumPiece = this.minimumTearPiece;
    const minimumAnchor = Math.max(1, Math.min(Math.max(8, Math.round(this.totalCells * 0.002)),
      Math.ceil(this.componentAdheredCells * 0.015)));
    const reverseTravel = this.heldReach - inwardTravel;
    const canLoadOutward = this.tearFactors.outward > 0 && reverseTravel > OUTWARD_DEAD_ZONE
      && this.componentAdheredCells - this.pendingNewCells >= minimumAnchor;
    if (canLoadOutward && !this.liftedCells && inwardTravel < -OUTWARD_DEAD_ZONE
      && this.gestureBase[this.grabIndex] === Cell.released) {
      this.liftReleasedFlap(minimumPiece);
    }
    if (canLoadOutward && this.liftedCells >= minimumPiece) {
      this.strainTravel = 0;
      this.outwardPulling = reverseTravel > OUTWARD_DEAD_ZONE;
      const distanceLoad = Math.max(0, reverseTravel - OUTWARD_DEAD_ZONE) / OUTWARD_LOAD_DISTANCE;
      const elapsed = this.lastTime > 0 ? clamp((time - this.lastTime) / 1000, 0, 0.1) : 0;
      this.outwardSeconds = distanceLoad > 0 ? this.outwardSeconds + elapsed : 0;
      const outwardLoad = clamp(this.tearFactors.outward * (distanceLoad + this.outwardSeconds * 2.5));
      this.stress = Math.max(this.heldStress, outwardLoad);
      this.warningLoad = outwardLoad;
      this.warningDirection = inward;
      this.lastPointer = { ...point };
      this.lastTime = time;
      const outwardTear = outwardLoad > 0 && outwardLoad >= this.tearThreshold;
      this.lastDiagnosticStep = {
        ...this.lastDiagnosticStep,
        previousPendingCells: this.pendingNewCells,
        pendingNewCells: this.pendingNewCells,
        liftedCells: this.liftedCells,
        pullDistance,
        targetStress: this.stress,
        minimumPiece,
        stressTear: outwardTear,
        outwardTear,
      };
      if (outwardTear) {
        this.direction = { x: -inward.x, y: -inward.y };
        this.triggerTear({ kind: "outward", value: outwardLoad, threshold: this.tearThreshold });
      }
      return;
    }
    this.outwardPulling = false;
    this.outwardSeconds = 0;
    if (travel < 0.001 || pullDistance < 0.001 || inwardTravel <= travel * 0.2
      || inwardDistance <= pullDistance * 0.2) {
      if (this.liftedCells > 0) this.state.set(this.gestureBase);
      this.pendingNewCells = 0;
      this.liftedCells = 0;
      this.frontDepth = 0;
      this.heldReach = 0;
      this.heldStress = 0;
      this.strainTravel = 0;
      this.stress *= 0.8;
      this.lastPointer = { ...point };
      this.lastTime = time;
      return;
    }
    // In the center of a balanced thin stroke, the first valid sweep picks a side.
    this.inward = inward;
    this.direction = { x: dx / pullDistance, y: dy / pullDistance };
    this.frontDepth = this.calcFrontDepth(inwardDistance);
    const previousPendingCells = this.pendingNewCells;
    const previousLiftedCells = this.liftedCells;
    const candidateStarted = performance.now();
    let tearCandidateCells = 0;
    let candidateAdheredCells = 0;
    this.tearCandidate.fill(0);
    if (previousLiftedCells > 0) {
      for (let index = 0; index < this.state.length; index++) {
        if (this.state[index] !== Cell.lifted) continue;
        this.tearCandidate[index] = 1;
        tearCandidateCells++;
        if (this.gestureBase[index] === Cell.adhered) candidateAdheredCells++;
      }
    } else if (this.gestureBase[this.grabIndex] === Cell.released) {
      tearCandidateCells = this.queueReleasedFlap();
      for (let i = 0; i < tearCandidateCells; i++) this.tearCandidate[this.queue[i]] = 1;
    }
    const frontStarted = performance.now();
    const frameDistance = Math.hypot((point.x - this.lastPointer.x) * this.aspect, point.y - this.lastPointer.y);
    const waveTravel = frameDistance * (this.height - 1) * FRONT_PROPAGATION_RATIO + this.frontTravelRemainder;
    const waves = Math.floor(waveTravel);
    this.frontTravelRemainder = waveTravel - waves;
    const { frontCells, averageAdhesion, queuedCells, newlyReleased } = this.rebuildLifted(waves);
    // A valid peel spends a move even if the flap later returns to the board.
    this.moveEarned ||= this.detached || this.canCommitPartial;
    const frontRebuildMs = performance.now() - frontStarted;

    // Detect sudden growth independently of how much was lifted before this update.
    const gainedCells = Math.max(0, this.pendingNewCells - previousPendingCells);
    const absoluteGain = gainedCells / Math.max(1, this.totalCells);
    this.areaJump = absoluteGain;

    const elapsed = this.lastTime > 0 && time > this.lastTime ? (time - this.lastTime) / 1000 : 1 / 60;
    const speed = frameDistance / Math.max(elapsed, 1 / 240);
    const hasAnchor = this.componentAdheredCells - this.pendingNewCells >= minimumAnchor;
    let bottleneckLoad = 0;
    let bottleneckMs = 0;
    if (this.tearFactors.bottleneck > 0 && hasAnchor && this.liftedCells >= minimumPiece) {
      const bottleneckStarted = performance.now();
      bottleneckLoad = Math.max(
        this.measureProjectedBottleneck(),
        frontCells <= LOCAL_NECK_MAX_WIDTH ? this.measureLocalBottleneck(queuedCells) : 0,
      );
      bottleneckMs = performance.now() - bottleneckStarted;
    }
    // A newly forming local front is short by construction. Ramp in the
    // narrow-front load as the adhesive line develops beyond the grip.
    const narrowLoad = clamp((18 - frontCells) / 16) * clamp(this.frontDepth / 0.045);
    const resistanceLoad = clamp((averageAdhesion - 0.42) / 0.58);
    const reachLoad = clamp(this.frontDepth / (this.aspect * 0.78));
    const speedLoad = clamp((speed - 1.5) / 5) * 0.12;
    const frontLoad = narrowLoad * this.shortFrontWeight;
    const shapeLoad = frontLoad + (1 - frontLoad) * bottleneckLoad * 0.8 * this.tearFactors.bottleneck;
    const targetStress = clamp(shapeLoad + resistanceLoad * 0.28 + reachLoad * 0.18 + speedLoad);
    const wasNearTear = this.tearThreshold > 0 && this.heldStress >= this.tearThreshold * 0.9;
    this.heldStress += (targetStress - this.heldStress) * 0.2;
    const stillNearTear = hasAnchor && this.liftedCells >= minimumPiece && this.heldStress >= this.tearThreshold * 0.9;
    this.strainTravel = wasNearTear && stillNearTear && inwardTravel >= this.heldReach
      ? this.strainTravel + inwardTravel - this.heldReach : 0;
    this.stress = clamp(this.heldStress + this.tearThreshold * 0.1 * clamp(this.strainTravel / 0.045));
    // Keep the furthest reach so small reversal steps can cross the dead zone
    // without skipping normal peel and neck updates while still inside it.
    this.heldReach = Math.max(this.heldReach, inwardTravel);
    this.lastPointer = { ...point };
    this.lastTime = time;

    const avalancheTear = hasAnchor && gainedCells > 0 && absoluteGain >= this.releaseJumpThreshold
      && this.liftedCells >= minimumPiece;
    if (avalancheTear && (tearCandidateCells < minimumPiece
      || this.componentAdheredCells - candidateAdheredCells < minimumAnchor)) {
      // With no viable previous flap, take a connected patch at the grip from
      // the current breadth-first traversal. The rest falls back to the board.
      this.tearCandidate.fill(0);
      tearCandidateCells = 0;
      for (let i = 0; i < queuedCells && tearCandidateCells < minimumPiece; i++) {
        const index = this.queue[i];
        if (this.state[index] !== Cell.lifted) continue;
        this.tearCandidate[index] = 1;
        tearCandidateCells++;
      }
    }
    const canTearUnderTension = hasAnchor && this.liftedCells >= minimumPiece;
    if (canTearUnderTension) this.warningLoad = this.stress;
    const stressTear = canTearUnderTension && this.stress >= this.tearThreshold;
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
      outwardTear: false,
      bottleneckLoad,
      tearCandidateMs: frontStarted - candidateStarted,
      frontRebuildMs,
      bottleneckMs,
    };
    if (avalancheTear) {
      this.triggerTear({ kind: "area-jump", value: absoluteGain, threshold: this.releaseJumpThreshold }, this.tearCandidate);
    } else if (stressTear) {
      this.triggerTear({ kind: "tension", value: this.stress, threshold: this.tearThreshold });
    }
    if (this.torn) return;
    const edgeReleased = !this.edgeCueSent && newlyReleased > 0 && this.reachedLeadingEdge();
    if (edgeReleased) this.edgeCueSent = true;
    return { edgeReleased, releasedFraction: newlyReleased / this.totalCells };
  }

  end(commit = true) {
    if (!this.tracking) return false;
    if (this.torn) {
      this.tracking = false;
      this.pulling = false;
      this.outwardPulling = false;
      this.failed = true;
      this.grabIndex = -1;
      return false;
    }
    const releasedWholeComponent = this.detached;
    const accepted = releasedWholeComponent || (commit && this.canCommitPartial);

    if (this.pulling) {
      for (let index = 0; index < this.state.length; index++) {
        const remove = accepted && releasedWholeComponent && this.grabbedComponent[index] !== 0;
        if (remove || (accepted && this.state[index] === Cell.lifted)) {
          this.state[index] = remove ? Cell.outside : Cell.released;
          if (!remove) this.releasedHistory[index] = 255;
        } else {
          this.state[index] = this.gestureBase[index];
        }
      }
    }
    if (accepted) {
      if (!releasedWholeComponent && this.state[this.grabIndex] === Cell.released) {
        this.previousGrips.set(this.grabIndex, { ...this.direction });
      }
      this.releasedHistoryRevision++;
      this.releasedCells += this.pendingNewCells;
    }
    if (accepted || this.moveEarned) this.moves++;

    this.pendingNewCells = 0;
    this.liftedCells = 0;
    this.tracking = false;
    this.pulling = false;
    this.outwardPulling = false;
    this.grabIndex = -1;
    this.frontDepth = 0;
    this.stress *= 0.32;
    return accepted;
  }

  applyGripGap(distance: number, limit: number, tornContact: Vec2 | null) {
    if (!this.canTearAtGrip) return false;

    // Leave some slack for the curl, then load the remaining tension cubically.
    const extension = clamp((distance / limit - 0.25) / 0.75);
    this.stress += Math.max(0, this.tearThreshold - this.stress) * extension ** 3;
    if (distance < limit) return false;

    this.triggerTear({ kind: "grip-gap", value: distance, threshold: limit });
    if (tornContact) {
      this.tearRecoil = { x: tornContact.x - this.grab.x, y: tornContact.y - this.grab.y };
      this.tornOffset = { ...this.tearRecoil };
    }
    return true;
  }

  private get canTearAtGrip() {
    return this.tracking && !this.torn && this.liftedCells >= this.minimumTearPiece && !this.detached;
  }

  tearWarning(gripDistance: number | null, gripLimit: number) {
    if (!this.canTearAtGrip) return null;
    // Use the active failure checks' own loads. Display stress can also include
    // old tension during a reversal and the visual stretch caused by grip gap.
    const peelRisk = this.tearThreshold > 0 ? this.warningLoad / this.tearThreshold : 0;
    const gripRisk = gripDistance === null ? 0 : gripDistance / gripLimit;
    const redirect = peelRisk > gripRisk && gripRisk < 0.75 ? this.warningDirection : null;
    return { risk: Math.max(peelRisk, gripRisk), redirect };
  }

  private get detached() {
    return this.tracking && this.pulling && !this.torn && this.frontDepth > 0.012
      && this.pendingNewCells > 0 && this.pendingNewCells === this.componentAdheredCells;
  }

  private get canCommitPartial() {
    const minimumCells = Math.max(10, Math.round(this.totalCells * 0.0015));
    return this.tracking && this.pulling && !this.torn
      && this.frontDepth > 0.012 && this.pendingNewCells >= minimumCells;
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
      outwardPulling: this.outwardPulling,
      canCommit: this.detached || this.canCommitPartial,
      detached: this.detached,
      complete: !this.torn && progress >= 0.997,
      failed: this.failed,
      tearFailure: this.tearFailure,
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

  remainingPeelTravel() {
    if (!this.tracking || !this.pulling || this.frontDepth <= 0 || this.outwardPulling || this.torn || this.detached) return null;
    const { x, y } = this.direction;
    const { left, right, bottom, top } = this.componentBounds;
    const alignment = x * this.inward.x + y * this.inward.y;
    if (alignment <= 0.2) return null;
    const farthestFront = (x >= 0 ? right : left) * x + (y >= 0 ? top : bottom) * y;
    const farthestCell = Math.hypot(Math.max(Math.abs(left), Math.abs(right)), Math.max(Math.abs(bottom), Math.abs(top)));
    const depth = Math.max(0.013, farthestFront + 2 / this.height, (farthestCell - 2 / (this.height - 1)) / 4);
    // Invert calcFrontDepth and account for the angle between the drag and the adhesive's inward direction.
    const reach = depth < PEEL_QUARTER_TURN ? depth / PEEL_QUARTER_TURN * PEEL_QUARTER_TRAVEL
      : depth < PEEL_HALF_TURN ? PEEL_QUARTER_TRAVEL + (depth / PEEL_QUARTER_TURN - 1) * (PEEL_HALF_TURN - PEEL_QUARTER_TRAVEL)
      : PEEL_HALF_TURN + (depth - PEEL_HALF_TURN) * 2;
    const current = (this.pointer.x - this.grab.x) * this.aspect * this.inward.x + (this.pointer.y - this.grab.y) * this.inward.y;
    return { direction: this.direction, distance: Math.max(0, reach - current) / alignment };
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
    const detached = this.detached;
    for (let index = 0, offset = 0; index < this.state.length; index++, offset += 4) {
      const value = detached && this.grabbedComponent[index] ? Cell.outside : this.state[index];
      target[offset] = value === Cell.adhered ? 255 : 0;
      target[offset + 1] = value === Cell.released ? 255 : 0;
      target[offset + 2] = value === Cell.lifted ? 255 : 0;
      target[offset + 3] = value === Cell.torn ? 255 : 0;
    }
  }

  writeDetachedTexture(target: Uint8Array) {
    if (target.length !== this.state.length * 4) throw new Error("State texture has the wrong size");
    if (!this.detached) return;
    for (let index = 0; index < this.state.length; index++) {
      target[index * 4 + 2] = this.grabbedComponent[index] ? 255 : 0;
    }
  }

  get releaseHistoryRevision() {
    return this.releasedHistoryRevision;
  }

  writeReleaseHistory(target: Uint8Array) {
    target.set(this.releasedHistory);
  }

  get releasedGrips(): ReadonlyMap<number, Vec2> {
    return this.previousGrips;
  }

  get activeGripCell() {
    return this.grabIndex;
  }

  setTearThreshold(value: number) {
    this.tearThreshold = clamp(value);
  }

  setReleaseJumpThreshold(value: number) {
    this.releaseJumpThreshold = clamp(value);
  }

  setTearFactors({ outward, bottleneck }: TearFactors) {
    this.tearFactors = { outward: clamp(outward), bottleneck: clamp(bottleneck) };
  }

  private acquire(index: number, origin: Vec2) {
    this.grabIndex = index;
    this.grab = this.cellPoint(index);
    this.pullOrigin = { ...origin };
    this.gestureBase.set(this.state);
    this.grabbedComponent.fill(0);
    this.exteriorReady = false;
    this.componentAdheredCells = 0;
    const bounds = this.componentBounds;
    bounds.left = bounds.right = bounds.bottom = bounds.top = 0;
    this.grabbedComponent[index] = 1;
    this.queue[0] = index;
    let tail = 1;
    const grabbingReleased = this.gestureBase[index] === Cell.released;
    const localRadiusSquared = (4 / (this.height - 1)) ** 2;
    let closestAdhered = Number.POSITIVE_INFINITY;
    let inwardX = 0;
    let inwardY = 0;
    const visit = (next: number) => {
      if (this.grabbedComponent[next] || this.gestureBase[next] === Cell.outside) return;
      this.grabbedComponent[next] = 1;
      this.queue[tail++] = next;
    };
    for (let head = 0; head < tail; head++) {
      const cell = this.queue[head];
      const x = cell % this.width;
      const dx = (x / (this.width - 1) - this.grab.x) * this.aspect;
      const dy = Math.floor(cell / this.width) / (this.height - 1) - this.grab.y;
      bounds.left = Math.min(bounds.left, dx);
      bounds.right = Math.max(bounds.right, dx);
      bounds.bottom = Math.min(bounds.bottom, dy);
      bounds.top = Math.max(bounds.top, dy);
      if (this.gestureBase[cell] === Cell.adhered) {
        this.componentAdheredCells++;
        const distance = dx * dx + dy * dy;
        if (grabbingReleased && distance < closestAdhered) {
          // A re-grab on a released flap must move toward its remaining adhesive.
          closestAdhered = distance;
          inwardX = dx;
          inwardY = dy;
        } else if (!grabbingReleased && distance <= localRadiusSquared) {
          // Use the material near the grip, including around holes and tips.
          inwardX += dx;
          inwardY += dy;
        }
      }
      if (x > 0) visit(cell - 1);
      if (x + 1 < this.width) visit(cell + 1);
      if (cell >= this.width) visit(cell - this.width);
      if (cell + this.width < this.state.length) visit(cell + this.width);
    }
    // A short front alone is meaningful on a thin stroke. Broad components
    // need evidence of a local constriction before they receive a strong load.
    const span = Math.hypot(bounds.right - bounds.left, bounds.top - bounds.bottom) * (this.height - 1);
    const averageWidth = tail / Math.max(1, span);
    this.shortFrontWeight = 0.1 + 0.44 * clamp((18 - averageWidth) / 12);
    let length = Math.hypot(inwardX, inwardY);
    if (length < 1e-6 && tail === 1 && !grabbingReleased) {
      // For an isolated pixel, only a press off its center identifies an edge.
      inwardX = (this.grab.x - origin.x) * this.aspect;
      inwardY = this.grab.y - origin.y;
      length = Math.hypot(inwardX, inwardY);
    }
    this.inward = length < 1e-6 ? { x: 0, y: 0 } : { x: inwardX / length, y: inwardY / length };
    this.pulling = true;
  }

  private inwardAlongThinStroke(dx: number, dy: number, distance: number): Vec2 {
    if (distance < 0.001) return { x: 0, y: 0 };
    const direction = { x: dx / distance, y: dy / distance };
    const probe = 1.25 / (this.height - 1);
    const x = Math.round((this.grab.x + direction.x * probe / this.aspect) * (this.width - 1));
    const y = Math.round((this.grab.y + direction.y * probe) * (this.height - 1));
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return { x: 0, y: 0 };
    const cell = y * this.width + x;
    return cell !== this.grabIndex && this.grabbedComponent[cell] && this.gestureBase[cell] === Cell.adhered
      ? direction : { x: 0, y: 0 };
  }

  private triggerTear(failure: TearFailure, detachedMask?: Uint8Array) {
    let detachedReleasedCells = 0;
    for (let index = 0; index < this.state.length; index++) {
      const shouldDetach = detachedMask ? detachedMask[index] !== 0 : this.state[index] === Cell.lifted;
      if (shouldDetach) {
        if (this.gestureBase[index] === Cell.released) this.queue[detachedReleasedCells++] = index;
        this.state[index] = Cell.torn;
      } else {
        this.state[index] = this.gestureBase[index];
      }
    }
    // A tear can cross fresh adhesive, but an already unglued patch has no
    // attachment within it to oppose the pull. Carry the entire touched patch.
    const initiallyDetached = detachedReleasedCells;
    const carryReleased = (index: number) => {
      if (this.state[index] !== Cell.released) return;
      this.state[index] = Cell.torn;
      this.queue[detachedReleasedCells++] = index;
    };
    for (let head = 0; head < detachedReleasedCells; head++) {
      const index = this.queue[head];
      const x = index % this.width;
      if (x > 0) carryReleased(index - 1);
      if (x + 1 < this.width) carryReleased(index + 1);
      if (index >= this.width) carryReleased(index - this.width);
      if (index + this.width < this.state.length) carryReleased(index + this.width);
    }
    this.lastDiagnosticStep.tornPreviouslyReleasedCells = detachedReleasedCells;
    this.lastDiagnosticStep.carriedReleasedCells = detachedReleasedCells - initiallyDetached;
    this.releasedCells = Math.max(0, this.releasedCells - detachedReleasedCells);
    this.pendingNewCells = 0;
    this.liftedCells = 0;
    this.torn = true;
    this.failed = true;
    this.tearFailure = failure;
    this.tearOrigin = { ...this.pointer };
    this.tearRecoil = {
      x: this.direction.x * 0.035 / this.aspect,
      y: this.direction.y * 0.035,
    };
    this.tornOffset = { ...this.tearRecoil };
    this.stress = Math.max(this.stress, this.tearThreshold);
  }

  private queueReleasedFlap() {
    this.visited.fill(0);
    this.queue[0] = this.grabIndex;
    this.visited[this.grabIndex] = 1;
    let tail = 1;
    const visit = (index: number) => {
      if (this.visited[index] || this.gestureBase[index] !== Cell.released) return;
      this.visited[index] = 1;
      this.queue[tail++] = index;
    };
    for (let head = 0; head < tail; head++) {
      const cell = this.queue[head];
      const x = cell % this.width;
      if (x > 0) visit(cell - 1);
      if (x + 1 < this.width) visit(cell + 1);
      if (cell >= this.width) visit(cell - this.width);
      if (cell + this.width < this.state.length) visit(cell + this.width);
    }
    return tail;
  }

  private liftReleasedFlap(minimumPiece: number) {
    const tail = this.queueReleasedFlap();
    if (tail < minimumPiece) return;
    let depth = 0;
    for (let index = 0; index < tail; index++) {
      const cell = this.queue[index];
      const point = this.cellPoint(cell);
      depth = Math.max(depth, (point.x - this.grab.x) * this.aspect * this.inward.x
        + (point.y - this.grab.y) * this.inward.y);
      this.state[cell] = Cell.lifted;
    }
    this.liftedCells = tail;
    this.direction = this.inward;
    this.frontDepth = depth + 1 / this.height;
  }

  private measureLocalBottleneck(queuedCells: number) {
    const front: number[] = [];
    const { state, width } = this;
    // The projected slice can cross other arms of the sticker. Count only
    // lifted cells that actually transfer the pull to still-adhered material.
    for (let i = 0; i < queuedCells; i++) {
      const cell = this.queue[i];
      if (state[cell] !== Cell.lifted) continue;
      const x = cell % width;
      if ((x > 0 && state[cell - 1] === Cell.adhered)
        || (x + 1 < width && state[cell + 1] === Cell.adhered)
        || state[cell - width] === Cell.adhered || state[cell + width] === Cell.adhered) {
        front.push(cell);
        if (front.length > LOCAL_NECK_MAX_WIDTH) return 0;
      }
    }
    if (front.length === 0) return 0;

    // A tip or uniform thin strip lacks a broad shoulder on one or both sides.
    // Use graph distance so the shoulders can wrap around holes or bend away
    // from the pull direction.
    const shoulderWidth = Math.max(8, front.length * 2);
    this.visited.fill(0);
    if (!this.hasNeckShoulder(front, Cell.lifted, shoulderWidth)
      || !this.hasNeckShoulder(front, Cell.adhered, shoulderWidth)) return 0;

    return (LOCAL_NECK_MAX_WIDTH + 1 - front.length) / LOCAL_NECK_MAX_WIDTH;
  }

  private hasNeckShoulder(front: readonly number[], layer: number, shoulderWidth: number) {
    const { state, width, visited, nextFrontWave: queue } = this;
    let tail = 0;
    let broad = false;
    const visit = (cell: number) => {
      if (state[cell] !== layer || visited[cell]) return;
      visited[cell] = 1;
      queue[tail++] = cell;
    };
    const visitNeighbors = (cell: number) => {
      const x = cell % width;
      if (x > 0) visit(cell - 1);
      if (x + 1 < width) visit(cell + 1);
      visit(cell - width);
      visit(cell + width);
    };
    for (const cell of front) {
      if (layer === Cell.lifted) visit(cell);
      else visitNeighbors(cell);
    }
    for (let head = 0; head < tail;) {
      const end = tail;
      broad ||= end - head >= shoulderWidth;
      if (broad && tail >= this.minimumTearPiece) return true;
      while (head < end) visitNeighbors(queue[head++]);
    }
    return false;
  }

  private measureProjectedBottleneck() {
    const widths = this.sectionWidths;
    widths.fill(0);
    const center = (widths.length - 1) / 2;
    const slicesPerUnit = (this.height - 1) / 2;
    const stepX = this.direction.x * this.aspect / (this.width - 1);
    const stepY = this.direction.y / (this.height - 1);
    const origin = this.grab.x * this.aspect * this.direction.x + this.grab.y * this.direction.y + this.frontDepth;
    for (let y = 0; y < this.height; y++) {
      const row = y * this.width;
      for (let x = 0; x < this.width; x++) {
        const cell = row + x;
        if (!this.grabbedComponent[cell]) continue;
        const slice = Math.round((x * stepX + y * stepY - origin) * slicesPerUnit);
        const layer = this.state[cell];
        if (Math.abs(slice) <= 1 || (slice < 0 ? layer === Cell.lifted : layer === Cell.adhered)) {
          const index = center + slice;
          if (index >= 0 && index < widths.length) widths[index]++;
        }
      }
    }
    let behind = 0;
    let ahead = 0;
    for (let i = 0; i + 2 < center - 1; i++) {
      behind = Math.max(behind, widths[i] + widths[i + 1] + widths[i + 2]);
    }
    for (let i = center + 2; i + 2 < widths.length; i++) {
      ahead = Math.max(ahead, widths[i] + widths[i + 1] + widths[i + 2]);
    }
    // A tip has only one wide side. A loaded neck has material on both sides.
    const shoulders = Math.min(behind, ahead);
    const neck = widths[center - 1] + widths[center] + widths[center + 1];
    return shoulders > 0 && neck > 0 ? clamp((0.75 - neck / shoulders) / 0.65) : 0;
  }

  private calcFrontDepth(pointerDistance: number) {
    if (pointerDistance < PEEL_QUARTER_TRAVEL) return pointerDistance / PEEL_QUARTER_TRAVEL * PEEL_QUARTER_TURN;
    if (pointerDistance < PEEL_HALF_TURN) {
      return ((pointerDistance - PEEL_QUARTER_TRAVEL) / (PEEL_HALF_TURN - PEEL_QUARTER_TRAVEL) + 1) * PEEL_QUARTER_TURN;
    }
    return PEEL_HALF_TURN + (pointerDistance - PEEL_HALF_TURN) * 0.5;
  }

  private rebuildLifted(waves: number) {
    this.state.set(this.gestureBase);
    this.visited.fill(0);
    this.pendingNewCells = 0;
    this.liftedCells = 0;
    let adhesionSum = 0;
    let newlyReleased = 0;
    let frontCells = 0;
    let head = 0;
    let tail = 0;
    let waveCount = 0;
    this.queue[tail++] = this.grabIndex;
    this.visited[this.grabIndex] = 1;

    const grabX = this.grab.x * this.aspect;
    const grabY = this.grab.y;
    const frontX = grabX + this.direction.x * this.frontDepth;
    const frontY = grabY + this.direction.y * this.frontDepth;
    // A shallow front must start locally. An infinite peel line could grab a
    // distant lobe on the rear side even when the pointer barely moved.
    const pickupRadiusSquared = (2 / (this.height - 1) + 4 * this.frontDepth) ** 2;
    const edgeTolerance = 0.7 / this.height;
    const dx4 = [-1, 1, 0, 0];
    const dy4 = [0, 0, -1, 1];

    while (head < tail || (waves > 0 && waveCount > 0)) {
      if (head === tail) {
        this.queue.set(this.nextFrontWave.subarray(0, waveCount), tail);
        tail += waveCount;
        waveCount = 0;
        waves--;
      }
      const index = this.queue[head++];
      const base = this.gestureBase[index];
      if (base === Cell.outside) continue;
      const x = index % this.width;
      const y = Math.floor(index / this.width);
      const metricX = x / (this.width - 1) * this.aspect;
      const metricY = y / (this.height - 1);
      if (base === Cell.adhered && (metricX - grabX) ** 2 + (metricY - grabY) ** 2 > pickupRadiusSquared) continue;
      const signed = (metricX - frontX) * this.direction.x + (metricY - frontY) * this.direction.y;
      const adhesiveDelay = (this.adhesion[index] - 0.58) * 0.012;
      if (index !== this.grabIndex && signed > edgeTolerance - adhesiveDelay) continue;

      this.state[index] = Cell.lifted;
      this.liftedCells++;
      if (base === Cell.adhered) {
        this.pendingNewCells++;
        adhesionSum += this.adhesion[index];
        if (!this.tearCandidate[index]) newlyReleased++;
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
          // The held flap transmits the pull immediately. Newly unglued cells
          // advance in local waves paid for by this update's pointer travel.
          if (this.tearCandidate[next] || this.gestureBase[next] === Cell.released) {
            this.queue[tail++] = next;
            this.visited[next] = 1;
          } else if (waves > 0) {
            this.nextFrontWave[waveCount++] = next;
            this.visited[next] = 1;
          } else {
            this.visited[next] = 2;
          }
        }
        // A still-glued neighbor beyond this update's travel is also a live peel front.
        if (this.visited[next] === 2) touchesFront = true;
      }
      if (touchesFront) frontCells++;
    }

    return { frontCells, averageAdhesion: adhesionSum / Math.max(1, this.pendingNewCells), queuedCells: tail, newlyReleased };
  }

  private reachedLeadingEdge() {
    const { width, height, direction, grabbedComponent } = this;
    const cellAt = (x: number, y: number) =>
      x >= 0 && x < width && y >= 0 && y < height && grabbedComponent[y * width + x] ? y * width + x : -1;
    const gx = this.grabIndex % width;
    const gy = Math.floor(this.grabIndex / width);
    const stepX = direction.x * (width - 1) / (2 * this.aspect * (height - 1));
    const stepY = direction.y / 2;
    const { left, right, bottom, top } = this.componentBounds;
    const reachX = direction.x === 0 ? Infinity : (direction.x > 0 ? right : left) / direction.x;
    const reachY = direction.y === 0 ? Infinity : (direction.y > 0 ? top : bottom) / direction.y;
    const maxSteps = Math.ceil(Math.min(reachX, reachY) * 2 * (height - 1)) + 2;
    const minSteps = this.detached ? 1 : 6;
    let tip = -1;
    // Trace back from beyond the sheet. An earlier exit through a hole or
    // concavity is not the edge this sweep is approaching.
    for (let step = maxSteps; step >= minSteps; step--) {
      tip = cellAt(Math.round(gx + stepX * step), Math.round(gy + stepY * step));
      if (tip >= 0) break;
    }
    if (tip < 0 || tip === this.grabIndex || this.state[tip] === Cell.adhered) return false;

    if (!this.exteriorReady) this.markComponentExterior();
    const outside = (x: number, y: number) =>
      x < 0 || x >= width || y < 0 || y >= height || this.componentExterior[y * width + x] !== 0;

    const tx = tip % width;
    const ty = Math.floor(tip / width);
    const facingX = Math.abs(direction.x) >= 0.35 ? Math.sign(direction.x) : 0;
    const facingY = Math.abs(direction.y) >= 0.35 ? Math.sign(direction.y) : 0;
    let fresh = false;
    // Wait for the nearby forward-facing rim, including neighbors with
    // different adhesion delays, to be free before announcing it.
    for (let y = ty - 2; y <= ty + 2; y++) {
      for (let x = tx - 2; x <= tx + 2; x++) {
        const neighbor = cellAt(x, y);
        if (neighbor < 0 || (!outside(x + facingX, y) && !outside(x, y + facingY))) continue;
        if (this.state[neighbor] === Cell.adhered) return false;
        if (this.gestureBase[neighbor] === Cell.adhered && !this.tearCandidate[neighbor]) fresh = true;
      }
    }
    return fresh;
  }

  private markComponentExterior() {
    const { width, height, componentExterior, grabbedComponent, queue } = this;
    componentExterior.fill(0);
    let tail = 0;
    const visit = (index: number) => {
      if (grabbedComponent[index] || componentExterior[index]) return;
      componentExterior[index] = 1;
      queue[tail++] = index;
    };
    for (let x = 0; x < width; x++) {
      visit(x);
      visit((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
      visit(y * width);
      visit(y * width + width - 1);
    }
    for (let head = 0; head < tail; head++) {
      const index = queue[head];
      const x = index % width;
      if (x > 0) visit(index - 1);
      if (x < width - 1) visit(index + 1);
      if (index >= width) visit(index - width);
      if (index < componentExterior.length - width) visit(index + width);
    }
    this.exteriorReady = true;
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
