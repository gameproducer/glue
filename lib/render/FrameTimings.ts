const FRAME_LIMIT = 2400;

type FrameWork = {
  phase: "idle" | "drag" | "dissolve";
  visible: boolean;
  animationMs: number;
  cameraMs: number;
  renderSubmitMs: number;
};

type FrameTiming = FrameWork & {
  time: number;
  intervalMs: number | null;
  inputEvents: number;
  solverMs: number;
  stateUpdates: number;
  texturePrepMs: number;
  poseMs: number;
};

export class FrameTimings {
  private readonly frames: FrameTiming[] = [];
  private next = 0;
  private previous = 0;
  private inputEvents = 0;
  private solverMs = 0;
  private stateUpdates = 0;
  private texturePrepMs = 0;
  private poseMs = 0;

  recordInput(solverMs: number) {
    this.inputEvents++;
    this.solverMs += solverMs;
  }

  recordState(texturePrepMs: number, poseMs: number) {
    this.stateUpdates++;
    this.texturePrepMs += texturePrepMs;
    this.poseMs += poseMs;
  }

  recordFrame(time: number, work: FrameWork) {
    this.frames[this.next] = {
      time,
      intervalMs: this.previous ? time - this.previous : null,
      inputEvents: this.inputEvents,
      solverMs: this.solverMs,
      stateUpdates: this.stateUpdates,
      texturePrepMs: this.texturePrepMs,
      poseMs: this.poseMs,
      ...work,
    };
    this.next = (this.next + 1) % FRAME_LIMIT;
    this.previous = time;
    this.inputEvents = this.solverMs = this.stateUpdates = this.texturePrepMs = this.poseMs = 0;
  }

  clear() {
    this.frames.length = this.next = this.previous = 0;
    this.inputEvents = this.solverMs = this.stateUpdates = this.texturePrepMs = this.poseMs = 0;
  }

  export(startedAt: number) {
    const frames = this.frames.length < FRAME_LIMIT ? this.frames
      : [...this.frames.slice(this.next), ...this.frames.slice(0, this.next)];
    return frames.map(({ time, ...work }) => ({ elapsedMs: time - startedAt, ...work }));
  }
}
