import test from "node:test";
import assert from "node:assert/strict";
import { PeelSimulation } from "../lib/peel/PeelSimulation.ts";

test("sticker mask preserves cutouts", () => {
  assert.equal(PeelSimulation.contains(0.5, 0.5), true);
  assert.equal(PeelSimulation.contains(0.325, 0.64), false);
  assert.equal(PeelSimulation.contains(0.675, 0.64), false);
  assert.equal(PeelSimulation.contains(0.01, 0.01), false);
});

test("the same gesture produces identical release state", () => {
  const run = () => {
    const simulation = new PeelSimulation(80, 72, 1234);
    assert.equal(simulation.begin({ x: 0.96, y: 0.52 }, 100), true);
    simulation.drag({ x: 1.25, y: 0.52 }, 320);
    simulation.drag({ x: 1.52, y: 0.48 }, 620);
    simulation.end(true);
    return { state: [...simulation.state], snapshot: simulation.snapshot() };
  };
  const first = run();
  const second = run();
  assert.deepEqual(first.state, second.state);
  assert.equal(first.snapshot.progress, second.snapshot.progress);
  assert.equal(first.snapshot.moves, 1);
});

test("pulling farther advances the ungluing front", () => {
  const simulation = new PeelSimulation(88, 80, 7);
  assert.equal(simulation.begin({ x: 0.97, y: 0.5 }, 100), true);
  simulation.drag({ x: 1.12, y: 0.5 }, 300);
  const near = simulation.snapshot().progress;
  simulation.drag({ x: 1.55, y: 0.5 }, 700);
  const far = simulation.snapshot().progress;
  assert.ok(near > 0);
  assert.ok(far > near);
});
