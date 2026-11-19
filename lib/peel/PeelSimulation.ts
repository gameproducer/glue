import { Cell } from "./PeelCells.ts";
import { ElasticPeel } from "./ElasticPeel.ts";
import { SurfaceField, surfaceResistance, type SurfaceKind } from "./SurfaceField.ts";
export { Cell } from "./PeelCells.ts";

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
const EXPERIMENT_TRAVEL_STEP = 0.009;

type FrontSample = {
  frontCells: number; averageAdhesion: number; queuedCells: number; surfaceLoad: number; contactAdhesion: number;
};
const emptyFront = (): FrontSample => ({
  frontCells: 0, averageAdhesion: 0, queuedCells: 0, surfaceLoad: 1, contactAdhesion: 0,
});

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
    elasticReaction?: number;
    elasticStrain?: number;
    elasticDisplacement?: Vec2;
    surfaceLoad?: number;
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
  private readonly gestureBase: Uint8Array;
  private readonly tearCandidate: Uint8Array;
  private readonly grabbedComponent: Uint8Array;
  private readonly sectionWidths: Uint32Array;
  private componentAdheredCells = 0;
  private readonly componentBounds = { left: 0, right: 0, bottom: 0, top: 0 };
  private readonly visited: Uint8Array;
  private readonly queue: Int32Array;
  private readonly nextFrontWave: Int32Array;
  private totalCells = 0;
  private releasedCells = 0;
  private releasedHistoryRevision = 0;
  private pendingNewCells = 0;
  private liftedCells = 0;
  private moves = 0;
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
  private areaJump = 0;
  private frontTravelRemainder = 0;
  private physicsSample = 0;
  private lastDiagnosticStep = emptyDiagnosticStep();
  private lastPointer: Vec2 = { ...this.grab };
  private lastTime = 0;
  private spring: ElasticPeel | null = null;
  private elasticity = 0;
  private terrain: SurfaceField | null = null;
  private terrainSamples: Float32Array | null = null;
  private gripHeight = 0;
  private frontSample = emptyFront();
  private inputPoint: Vec2 = { ...this.grab };
  private inputTime = 0;
  private inputRemainder = 0;
  private experimentalStress = 0;

  get elasticPeel() { return this.spring; }
  get surface() { return this.terrain; }
  get experimentalSettings() { return { elasticity: this.elasticity, surface: this.terrain?.kind ?? "off" }; }

  setExperiments(elasticity: number, surface: SurfaceKind, surfaceAspect = this.aspect) {
    this.elasticity = Number.isFinite(elasticity) ? clamp(elasticity) : 0;
    this.spring = this.elasticity > 0 ? this.spring ?? new ElasticPeel(this.width, this.height) : null;
    if ((this.terrain?.kind ?? "off") === surface && (!this.terrain || this.terrain.aspect === surfaceAspect)) return;
    this.terrain = surface === "off" ? null : new SurfaceField(surface, surfaceAspect);
    this.terrainSamples = null;
    if (!this.terrain) return;
    this.terrainSamples = new Float32Array(this.state.length * 3);
    for (let i = 0; i < this.initialState.length; i++) {
      if (this.initialState[i] === Cell.outside) continue;
      const { x, y } = this.cellPoint(i);
      const slope = this.terrain.gradient(x, y);
      this.terrainSamples[i * 3] = this.terrain.height(x, y);
      this.terrainSamples[i * 3 + 1] = slope.x;
      this.terrainSamples[i * 3 + 2] = slope.y;
    }
  }

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
    this.releasedHistory = new Uint8Array(count);
    this.gestureBase = new Uint8Array(count);
    this.tearCandidate = new Uint8Array(count);
    this.grabbedComponent = new Uint8Array(count);
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
    this.spring?.reset();
    this.frontSample = emptyFront();
    this.experimentalStress = 0;
    this.state.set(this.initialState);
    this.releasedHistory.fill(0);
    this.releasedHistoryRevision++;
    this.releasedCells = 0;
    this.pendingNewCells = 0;
    this.liftedCells = 0;
    this.moves = 0;
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
    this.pulling = false;
    this.outwardPulling = false;
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
    this.areaJump = 0;
    this.physicsSample++;
    this.lastDiagnosticStep = emptyDiagnosticStep();
    this.grabIndex = -1;
    if (this.spring || this.terrain) {
      this.spring?.reset();
      this.frontSample = emptyFront();
      this.inputPoint = { ...point };
      this.inputTime = time;
      this.inputRemainder = 0;
      this.experimentalStress = 0;
    }
    const seed = this.nearestAccessibleCell(point);
    if (seed >= 0) this.acquire(seed, point);
    return true;
  }

  drag(point: Vec2, time: number) {
    if ((!this.spring && !this.terrain) || !this.tracking || this.torn || this.detached) {
      this.dragStep(point, time);
      return;
    }
    // Solve at fixed increments of actual pointer travel. Splitting the same
    // gesture across more browser events cannot add extra work to the peel front.
    const start = this.inputPoint;
    const x = point.x - start.x;
    const y = point.y - start.y;
    const length = Math.hypot(x * this.aspect, y);
    if (length < 1e-8) return;
    this.stress = this.experimentalStress;
    let distance = EXPERIMENT_TRAVEL_STEP - this.inputRemainder;
    let maxJump = 0;
    for (; distance <= length + 1e-9; distance += EXPERIMENT_TRAVEL_STEP) {
      const fraction = Math.min(1, distance / length);
      this.dragStep({ x: start.x + x * fraction, y: start.y + y * fraction }, this.inputTime + (time - this.inputTime) * fraction);
      this.experimentalStress = this.stress;
      maxJump = Math.max(maxJump, this.areaJump);
      if (this.torn || this.detached) break;
    }
    this.areaJump = maxJump;
    this.inputRemainder = clamp(length - distance + EXPERIMENT_TRAVEL_STEP, 0, EXPERIMENT_TRAVEL_STEP);
    this.inputPoint = { ...point };
    this.inputTime = time;
    if (this.torn) {
      this.tornOffset = {
        x: this.tearRecoil.x + point.x - this.tearOrigin.x,
        y: this.tearRecoil.y + point.y - this.tearOrigin.y,
      };
    } else {
      this.pointer = { ...point };
      if (this.detached) this.spring?.reset();
      else if (this.spring && this.liftedCells) {
        this.spring.deform((point.x - this.grab.x) * this.aspect, point.y - this.grab.y, this.inward, this.elasticity);
        this.lastDiagnosticStep.elasticStrain = this.spring.peakStrain;
        this.lastDiagnosticStep.elasticDisplacement = { ...this.spring.displacement };
      }
    }
  }

  private dragStep(point: Vec2, time: number) {
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
    const minimumPiece = Math.max(8, Math.round(this.totalCells * 0.002));
    const minimumAnchor = Math.max(1, Math.min(minimumPiece, Math.ceil(this.componentAdheredCells * 0.015)));
    const reverseTravel = this.spring ? this.spring.reach - inwardDistance : this.heldReach - inwardTravel;
    const canLoadOutward = this.tearFactors.outward > 0 && reverseTravel > 1e-6
      && this.componentAdheredCells - this.pendingNewCells >= minimumAnchor;
    if (canLoadOutward && !this.liftedCells && inwardTravel < -OUTWARD_DEAD_ZONE
      && this.gestureBase[this.grabIndex] === Cell.released) {
      this.liftReleasedFlap(minimumPiece);
      if (this.liftedCells) this.spring?.rebuild(this.state, this.grabIndex);
    }
    if (canLoadOutward && this.liftedCells >= minimumPiece) {
      this.strainTravel = 0;
      this.outwardPulling = reverseTravel > OUTWARD_DEAD_ZONE;
      const distanceLoad = Math.max(0, reverseTravel - OUTWARD_DEAD_ZONE) / OUTWARD_LOAD_DISTANCE;
      const elapsed = this.lastTime > 0 ? clamp((time - this.lastTime) / 1000, 0, 0.1) : 0;
      this.outwardSeconds = distanceLoad > 0 ? this.outwardSeconds + elapsed : 0;
      const outwardLoad = clamp(this.tearFactors.outward * (distanceLoad + this.outwardSeconds * 2.5));
      this.stress = Math.max(this.heldStress, outwardLoad);
      this.lastPointer = { ...point };
      this.lastTime = time;
      const outwardTear = outwardLoad > 0 && outwardLoad >= this.tearThreshold;
      this.spring?.deform(dx, dy, inward, this.elasticity);
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
      this.spring?.reset();
      this.frontSample = emptyFront();
      this.lastPointer = { ...point };
      this.lastTime = time;
      return;
    }
    // In the center of a balanced thin stroke, the first valid sweep picks a side.
    this.inward = inward;
    const previousReach = this.spring?.reach ?? 0;
    const drivenReach = this.spring?.advance(inwardDistance, this.elasticity,
      this.frontSample.contactAdhesion || this.adhesion[this.grabIndex], this.frontSample.surfaceLoad) ?? inwardDistance;
    const stoppedAtSeam = !!this.spring && this.liftedCells > 0 && Math.abs(drivenReach - previousReach) < 1e-8;
    if (!stoppedAtSeam) {
      this.direction = { x: dx / pullDistance, y: dy / pullDistance };
      this.frontDepth = this.calcFrontDepth(drivenReach);
    }
    this.spring?.deform(dx, dy, inward, this.elasticity);
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
    const frontTravel = this.spring ? Math.abs(drivenReach - previousReach) : frameDistance;
    const waveTravel = frontTravel * (this.height - 1) * FRONT_PROPAGATION_RATIO + this.frontTravelRemainder;
    const waves = Math.floor(waveTravel);
    this.frontTravelRemainder = waveTravel - waves;
    if (!stoppedAtSeam) {
      this.frontSample = this.rebuildLifted(waves);
      this.spring?.rebuild(this.state, this.grabIndex);
      this.spring?.deform(dx, dy, inward, this.elasticity);
    }
    const { frontCells, averageAdhesion, queuedCells, surfaceLoad } = this.frontSample;
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
      bottleneckLoad = this.measureBottleneck();
      bottleneckMs = performance.now() - bottleneckStarted;
    }
    // A newly forming local front is short by construction. Ramp in the
    // narrow-front load as the adhesive line develops beyond the grip.
    const narrowLoad = clamp((18 - frontCells) / 16) * clamp(this.frontDepth / 0.045);
    const resistanceLoad = clamp((averageAdhesion - 0.42) / 0.58);
    const reachLoad = clamp(this.frontDepth / (this.aspect * 0.78));
    const speedLoad = clamp((speed - 1.5) / 5) * 0.12;
    const shapeLoad = narrowLoad * 0.54 * (1 - this.tearFactors.bottleneck)
      + bottleneckLoad * 0.8 * this.tearFactors.bottleneck;
    const experimentalLoad = (this.spring ? Math.min(0.17, this.spring.peakStrain * 0.105) : 0)
      + (this.terrain ? (surfaceLoad - 1) * 0.24 : 0);
    const targetStress = clamp(shapeLoad + resistanceLoad * 0.28 + reachLoad * 0.18 + speedLoad + experimentalLoad);
    const wasNearTear = this.tearThreshold > 0 && this.heldStress >= this.tearThreshold * 0.9;
    const smoothing = this.spring || this.terrain ? 1 - Math.exp(-Math.min(0.12, elapsed) / 0.075) : 0.2;
    this.heldStress += (targetStress - this.heldStress) * smoothing;
    const stillNearTear = hasAnchor && this.liftedCells >= minimumPiece && this.heldStress >= this.tearThreshold * 0.9;
    this.strainTravel = wasNearTear && stillNearTear && inwardTravel >= this.heldReach
      ? this.strainTravel + inwardTravel - this.heldReach : 0;
    this.stress = clamp(this.heldStress + this.tearThreshold * 0.1 * clamp(this.strainTravel / 0.045));
    this.heldReach = inwardTravel;
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
      outwardTear: false,
      bottleneckLoad,
      tearCandidateMs: frontStarted - candidateStarted,
      frontRebuildMs,
      bottleneckMs,
    };
    if (this.spring) {
      this.lastDiagnosticStep.elasticReaction = this.spring.reaction;
      this.lastDiagnosticStep.elasticStrain = this.spring.peakStrain;
      this.lastDiagnosticStep.elasticDisplacement = { ...this.spring.displacement };
    }
    if (this.terrain) this.lastDiagnosticStep.surfaceLoad = surfaceLoad;
    if (avalancheTear) {
      this.triggerTear({ kind: "area-jump", value: absoluteGain, threshold: this.releaseJumpThreshold }, this.tearCandidate);
    } else if (stressTear) {
      this.triggerTear({ kind: "tension", value: this.stress, threshold: this.tearThreshold });
    }
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
      this.releasedHistoryRevision++;
      this.releasedCells += this.pendingNewCells;
      this.moves++;
    }

    this.pendingNewCells = 0;
    this.liftedCells = 0;
    this.tracking = false;
    this.pulling = false;
    this.outwardPulling = false;
    this.grabIndex = -1;
    this.frontDepth = 0;
    this.stress *= 0.32;
    this.spring?.reset();
    return accepted;
  }

  applyGripGap(distance: number, limit: number, tornContact: Vec2 | null) {
    if (!this.tracking || this.torn || !this.liftedCells || this.detached) return false;

    // Leave some slack for the curl, then load the remaining tension cubically.
    const extension = clamp((distance / limit - 0.25) / 0.75);
    const stress = this.spring || this.terrain ? this.experimentalStress : this.stress;
    this.stress = stress + Math.max(0, this.tearThreshold - stress) * extension ** 3;
    if (distance < limit) return false;

    this.triggerTear({ kind: "grip-gap", value: distance, threshold: limit });
    if (tornContact) {
      this.tearRecoil = { x: tornContact.x - this.grab.x, y: tornContact.y - this.grab.y };
      this.tornOffset = { ...this.tearRecoil };
    }
    return true;
  }

  private get detached() {
    return this.tracking && this.pulling && !this.torn && this.frontDepth > 0.012
      && this.pendingNewCells > 0 && this.pendingNewCells === this.componentAdheredCells;
  }

  private get canCommitPartial() {
    const minimumCells = Math.max(10, Math.round(this.totalCells * 0.0015));
    return this.tracking && this.pulling && !this.torn && !this.outwardPulling
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
    this.gripHeight = this.terrainSamples?.[index * 3] ?? 0;
    this.gestureBase.set(this.state);
    this.grabbedComponent.fill(0);
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

  private measureBottleneck() {
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

  private surfaceLoadAt(index: number) {
    const terrain = this.terrainSamples;
    if (!terrain) return 1;
    const offset = index * 3;
    return surfaceResistance(terrain[offset + 1] * this.direction.x + terrain[offset + 2] * this.direction.y,
      this.gripHeight - terrain[offset], this.frontDepth);
  }

  private rebuildLifted(waves: number) {
    this.state.set(this.gestureBase);
    this.visited.fill(0);
    this.pendingNewCells = 0;
    this.liftedCells = 0;
    let adhesionSum = 0;
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
      const surfaceDelay = this.terrain ? (this.surfaceLoadAt(index) - 1) * Math.min(0.095, this.frontDepth * 0.65) : 0;
      const springDelay = base === Cell.adhered && !this.tearCandidate[index]
        ? this.spring?.contactDelay(index, this.direction) ?? 0 : 0;
      const adhesiveDelay = (this.adhesion[index] - 0.58) * 0.012 + surfaceDelay + springDelay;
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

    // Modified adhesion can stop cells before the nominal front plane. Measure
    // the actual glued contact so a stationary front is not read as a thin neck.
    let surfaceLoad = 1;
    let contactAdhesion = 0;
    if (this.spring || this.terrain) {
      const front = this.measureExperimentalFront(tail);
      frontCells = front.cells;
      surfaceLoad = front.load;
      contactAdhesion = front.adhesion;
    }
    return {
      frontCells,
      averageAdhesion: adhesionSum / Math.max(1, this.pendingNewCells),
      queuedCells: tail,
      surfaceLoad,
      contactAdhesion,
    };
  }

  private measureExperimentalFront(tail: number) {
    const { state, queue, width } = this;
    let cells = 0;
    let bonds = 0;
    let loadSum = 0;
    let adhesionSum = 0;
    const addBond = (index: number) => {
      if (state[index] !== Cell.adhered) return;
      bonds++;
      adhesionSum += this.adhesion[index];
      loadSum += this.surfaceLoadAt(index);
    };
    for (let j = 0; j < tail; j++) {
      const index = queue[j];
      if (state[index] !== Cell.lifted) continue;
      const before = bonds;
      const col = index % width;
      if (col > 0) addBond(index - 1);
      if (col < width - 1) addBond(index + 1);
      addBond(index - width);
      addBond(index + width);
      if (bonds > before) cells++;
    }
    return { cells, load: bonds ? loadSum / bonds : 1, adhesion: bonds ? adhesionSum / bonds : 0 };
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
