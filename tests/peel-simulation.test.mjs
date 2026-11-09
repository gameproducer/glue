import test from "node:test";
import assert from "node:assert/strict";
import { Cell, PeelSimulation } from "../lib/peel/PeelSimulation.ts";

const rectangleMask = (width, height, left, right, bottom, top) => {
  const mask = new Uint8Array(width * height);
  for (let y = bottom; y <= top; y++) {
    for (let x = left; x <= right; x++) mask[y * width + x] = 1;
  }
  return mask;
};

test("fallback sticker mask preserves cutouts", () => {
  assert.equal(PeelSimulation.contains(0.5, 0.5), true);
  assert.equal(PeelSimulation.contains(0.325, 0.64), false);
  assert.equal(PeelSimulation.contains(0.675, 0.64), false);
  assert.equal(PeelSimulation.contains(0.01, 0.01), false);
});

test("any outer contour can be grabbed without first crossing it", () => {
  const width = 40;
  const height = 30;
  const mask = rectangleMask(width, height, 5, 34, 4, 25);
  const edgePoints = [
    { x: 5 / (width - 1), y: 15 / (height - 1) },
    { x: 34 / (width - 1), y: 15 / (height - 1) },
    { x: 20 / (width - 1), y: 4 / (height - 1) },
    { x: 20 / (width - 1), y: 25 / (height - 1) },
    { x: 5 / (width - 1), y: 4 / (height - 1) },
  ];

  for (const point of edgePoints) {
    const simulation = new PeelSimulation(width, height, 17, 4, mask);
    assert.equal(simulation.begin(point, 100), true);
    assert.equal(simulation.snapshot().pulling, true);
  }
});

test("a sweep only peels the connected component reached from its edge", () => {
  const width = 48;
  const height = 28;
  const mask = rectangleMask(width, height, 2, 20, 6, 21);
  const rightPiece = rectangleMask(width, height, 29, 44, 8, 19);
  for (let i = 0; i < mask.length; i++) mask[i] ||= rightPiece[i];
  const simulation = new PeelSimulation(width, height, 1234, 4, mask);

  assert.equal(simulation.begin({ x: 0, y: 0.5 }, 100), true);
  simulation.drag({ x: 0.34, y: 0.5 }, 420);
  const preview = simulation.snapshot().progress;
  assert.ok(preview > 0.08 && preview < 0.7);
  simulation.end(true);

  for (let y = 8; y <= 19; y++) {
    for (let x = 29; x <= 44; x++) assert.equal(simulation.state[y * width + x], Cell.adhered);
  }
});

test("pull direction changes the moving-front result", () => {
  const width = 64;
  const height = 24;
  const mask = rectangleMask(width, height, 3, 60, 9, 14);
  const run = (point) => {
    const simulation = new PeelSimulation(width, height, 77, 4, mask);
    simulation.begin({ x: 3 / (width - 1), y: 11 / (height - 1) }, 100);
    simulation.drag(point, 500);
    return simulation.snapshot().progress;
  };

  const alongArm = run({ x: 0.72, y: 11 / (height - 1) });
  const acrossArm = run({ x: 3 / (width - 1), y: 0.92 });
  assert.ok(Math.abs(alongArm - acrossArm) > 0.18);
});

test("released material persists and can seed the next pull", () => {
  const width = 52;
  const height = 30;
  const mask = rectangleMask(width, height, 3, 48, 5, 24);
  const simulation = new PeelSimulation(width, height, 9, 4, mask);

  simulation.begin({ x: 0.02, y: 0.5 }, 100);
  simulation.drag({ x: 0.28, y: 0.5 }, 400);
  assert.equal(simulation.end(true), true);
  const first = simulation.snapshot().progress;

  simulation.begin({ x: 0.16, y: 0.5 }, 700);
  simulation.drag({ x: 0.68, y: 0.5 }, 1100);
  assert.equal(simulation.end(true), true);
  const second = simulation.snapshot().progress;

  assert.equal(simulation.snapshot().moves, 2);
  assert.ok(first > 0 && second > first);
});

test("crossing the tear threshold detaches the lifted piece until release", () => {
  const width = 64;
  const height = 40;
  const mask = rectangleMask(width, height, 3, 60, 18, 21);
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 0.35);

  simulation.begin({ x: 0.02, y: 0.5 }, 100);
  for (let step = 1; step <= 12 && !simulation.snapshot().torn; step++) {
    simulation.drag({ x: 0.02 + step * 0.04, y: 0.5 }, 100 + step * 45);
  }

  const torn = simulation.snapshot();
  assert.equal(torn.torn, true);
  assert.equal(torn.tearDragging, true);
  assert.ok(simulation.state.some((value) => value === Cell.torn));
  assert.ok(simulation.state.some((value) => value === Cell.adhered));

  simulation.drag({ x: 0.74, y: 0.72 }, 900);
  assert.ok(Math.hypot(simulation.snapshot().tornOffset.x, simulation.snapshot().tornOffset.y) > 0.2);
  assert.equal(simulation.end(true), false);
  assert.equal(simulation.snapshot().failed, true);
  assert.ok(simulation.state.some((value) => value === Cell.torn));
});

test("a sudden release avalanche tears at the smaller previous front", () => {
  const width = 72;
  const height = 36;
  const mask = rectangleMask(width, height, 3, 68, 6, 29);
  const simulation = new PeelSimulation(width, height, 41, 4, mask, 0.9);

  simulation.begin({ x: 0.01, y: 0.5 }, 100);
  simulation.drag({ x: 0.16, y: 0.5 }, 420);
  assert.equal(simulation.end(true), true);
  const releasedBeforeJump = simulation.state.filter((value) => value === Cell.released).length;
  assert.ok(releasedBeforeJump > 8);

  simulation.begin({ x: 0.08, y: 0.5 }, 700);
  simulation.drag({ x: 0.96, y: 0.5 }, 760);

  const tornCells = simulation.state.filter((value) => value === Cell.torn).length;
  assert.equal(simulation.snapshot().torn, true);
  assert.ok(simulation.snapshot().areaJump >= simulation.snapshot().releaseJumpThreshold);
  assert.ok(simulation.diagnostics().lastStep.gainedCells > 0);
  assert.equal(simulation.diagnostics().lastStep.avalancheTear, true);
  assert.ok(tornCells >= releasedBeforeJump * 0.9);
  assert.ok(tornCells < simulation.state.length * 0.35);
  assert.ok(simulation.state.some((value) => value === Cell.adhered));
});

test("release-jump tearing has an independent threshold", () => {
  const width = 72;
  const height = 36;
  const mask = rectangleMask(width, height, 3, 68, 6, 29);
  const simulation = new PeelSimulation(width, height, 41, 4, mask, 0.9, 0.98);

  simulation.begin({ x: 0.01, y: 0.5 }, 100);
  simulation.drag({ x: 0.16, y: 0.5 }, 420);
  assert.equal(simulation.end(true), true);

  simulation.begin({ x: 0.08, y: 0.5 }, 700);
  simulation.drag({ x: 0.96, y: 0.5 }, 760);

  assert.equal(simulation.snapshot().torn, false);
  assert.equal(simulation.snapshot().releaseJumpThreshold, 0.98);
});

test("tear controls accept zero as a deliberate threshold", () => {
  const simulation = new PeelSimulation();
  simulation.setTearThreshold(0);
  simulation.setReleaseJumpThreshold(0);

  assert.equal(simulation.snapshot().tearThreshold, 0);
  assert.equal(simulation.snapshot().releaseJumpThreshold, 0);
});
