import test from "node:test";
import assert from "node:assert/strict";
import { FrameTimings } from "../lib/render/FrameTimings.ts";

test("frame timings align with diagnostic time and keep a bounded chronological history", () => {
  const timings = new FrameTimings();
  const work = { phase: "drag", visible: true, cameraMs: 0.1, renderSubmitMs: 0.8, animationMs: 0.2 };
  timings.recordFrame(104, work);
  timings.recordInput(1);
  timings.recordInput(2);
  timings.recordState(4, 5);
  timings.recordFrame(120, work);
  const [first, second] = timings.export(100);
  assert.equal(first.intervalMs, null);
  assert.deepEqual(second, {
    ...work, elapsedMs: 20, intervalMs: 16, inputEvents: 2, solverMs: 3,
    stateUpdates: 1, texturePrepMs: 4, poseMs: 5,
  });

  for (let i = 1; i <= 2400; i++) timings.recordFrame(120 + i * 16, work);
  const history = timings.export(100);
  assert.equal(history.length, 2400);
  assert.equal(history[0].elapsedMs, 36);
  assert.equal(history[0].inputEvents, 0);
  assert.equal(history.at(-1).elapsedMs, 20 + 2400 * 16);

  timings.recordInput(1);
  timings.clear();
  assert.deepEqual(timings.export(100), []);
  timings.recordFrame(130, work);
  assert.equal(timings.export(125)[0].inputEvents, 0);
  assert.equal(timings.export(125)[0].intervalMs, null);
});
