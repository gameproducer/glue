import test from "node:test";
import assert from "node:assert/strict";
import { Cell, PeelSimulation } from "../lib/peel/PeelSimulation.ts";
import { removeStickerSpecks } from "../lib/peel/StickerAsset.ts";

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

test("pulling out from any side, a corner, or into a cutout cannot release material", () => {
  const width = 64;
  const height = 40;
  const mask = rectangleMask(width, height, 10, 50, 8, 31);
  for (let y = 15; y <= 24; y++) {
    for (let x = 25; x <= 35; x++) mask[y * width + x] = 0;
  }
  const gestures = [
    [10, 20, -0.2, 20 / 39], [50, 20, 1.2, 20 / 39],
    [30, 8, 30 / 63, -0.2], [30, 31, 30 / 63, 1.2],
    [10, 8, -0.2, -0.2], [24, 20, 0.5, 20 / 39],
  ];

  for (const [x, y, targetX, targetY] of gestures) {
    const simulation = new PeelSimulation(width, height, 9, 4, mask, 0.24, 0.28);
    assert.equal(simulation.begin({ x: x / 63, y: y / 39 }, 100), true);
    assert.equal(simulation.snapshot().pulling, true);
    simulation.drag({ x: targetX, y: targetY }, 200);
    assert.equal(simulation.snapshot().progress, 0);
    assert.equal(simulation.snapshot().torn, false);
    assert.equal(simulation.end(true), false);
    assert.equal(simulation.snapshot().moves, 0);
  }
});

test("reversing outward restores a partial peel and the flap can still be re-grabbed inward", () => {
  const width = 52;
  const height = 30;
  const mask = rectangleMask(width, height, 3, 48, 5, 24);
  const simulation = new PeelSimulation(width, height, 9, 4, mask);
  simulation.begin({ x: 0.02, y: 0.5 }, 100);
  simulation.drag({ x: 0.28, y: 0.5 }, 400);
  assert.equal(simulation.end(true), true);
  const initialProgress = simulation.snapshot().progress;
  const initialState = simulation.state.slice();

  simulation.begin({ x: 0.16, y: 0.5 }, 700);
  simulation.drag({ x: 0.24, y: 0.5 }, 1000);
  assert.ok(simulation.snapshot().progress > initialProgress);
  simulation.drag({ x: -0.2, y: 0.5 }, 1200);
  assert.equal(simulation.snapshot().progress, initialProgress);
  assert.equal(simulation.snapshot().torn, false);
  assert.deepEqual(simulation.state, initialState);
  assert.equal(simulation.end(true), false);
  assert.equal(simulation.snapshot().moves, 1);

  simulation.begin({ x: 0.16, y: 0.5 }, 1400);
  simulation.drag({ x: 0.68, y: 0.5 }, 1800);
  assert.equal(simulation.end(true), true);
  assert.ok(simulation.snapshot().progress > initialProgress);
});

test("a sweep only peels the connected component reached from its edge", () => {
  const width = 48;
  const height = 28;
  const mask = rectangleMask(width, height, 2, 20, 6, 21);
  const rightPiece = rectangleMask(width, height, 29, 44, 8, 19);
  for (let i = 0; i < mask.length; i++) mask[i] ||= rightPiece[i];
  const simulation = new PeelSimulation(width, height, 1234, 4, mask, 0.78, 1);

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
    const simulation = new PeelSimulation(width, height, 77, 4, mask, 0.78, 1);
    simulation.begin({ x: 3 / (width - 1), y: 11 / (height - 1) }, 100);
    simulation.drag(point, 500);
    return simulation.snapshot().progress;
  };

  const alongArm = run({ x: 0.72, y: 11 / (height - 1) });
  const acrossArm = run({ x: 3 / (width - 1), y: 0.92 });
  assert.ok(alongArm > acrossArm + 0.10);
});

test("a tiny grab at an inner edge cannot pick up a distant connected lobe", () => {
  const size = 208;
  const mask = rectangleMask(size, size, 10, 190, 15, 190);
  for (let y = 60; y <= 145; y++) mask.fill(0, y * size + 91, y * size + 121);
  const grab = { x: 90 / 207, y: 101 / 207 };
  const simulation = new PeelSimulation(size, size, 41, 4, mask, 0.24, 0.09);
  simulation.begin(grab, 100);
  simulation.drag({ ...grab, x: grab.x - 0.004 }, 151);
  assert.ok(simulation.snapshot().progress > 0 && simulation.snapshot().progress < 0.02);
  assert.equal(simulation.snapshot().torn, false);
  assert.equal(simulation.state[101 * size + 160], Cell.adhered);
});

test("a slow pull past a corner lifts the newly reachable material in steps", () => {
  const size = 100;
  const mask = rectangleMask(size, size, 15, 29, 19, 81);
  for (let y = 19; y < 82; y++) mask.fill(1, y * size + 66, y * size + 82);
  for (let y = 66; y < 82; y++) mask.fill(1, y * size + 29, y * size + 67);
  const simulation = new PeelSimulation(size, size, 7, 2, mask, 1, 1);
  const start = { x: 29 / 99, y: 25 / 99 };
  simulation.begin(start, 100);
  let peakJump = 0;
  let point = start;
  for (let step = 1; step <= 80; step++) {
    const travel = step * 0.002;
    point = { x: start.x - Math.cos(0.1) * travel, y: start.y + Math.sin(0.1) * travel };
    simulation.drag(point, 100 + step * 16);
    peakJump = Math.max(peakJump, simulation.snapshot().areaJump);
  }
  assert.ok(peakJump < 0.07);
  assert.ok(simulation.state.some((cell, index) => cell === Cell.lifted && index % size >= 66));
  const progress = simulation.snapshot().progress;
  simulation.drag(point, 1500);
  assert.equal(simulation.snapshot().progress, progress);
  assert.equal(simulation.snapshot().areaJump, 0);
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
  assert.equal(torn.tearFailure.kind, "tension");
  assert.equal(torn.tearFailure.threshold, 0.35);
  assert.ok(torn.tearFailure.value >= torn.tearFailure.threshold);
  assert.ok(simulation.state.some((value) => value === Cell.torn));
  assert.ok(simulation.state.some((value) => value === Cell.adhered));

  simulation.drag({ x: 0.74, y: 0.72 }, 900);
  assert.ok(Math.hypot(simulation.snapshot().tornOffset.x, simulation.snapshot().tornOffset.y) > 0.2);
  assert.equal(simulation.end(true), false);
  assert.equal(simulation.snapshot().failed, true);
  assert.deepEqual(simulation.snapshot().tearFailure, torn.tearFailure);
  assert.ok(simulation.state.some((value) => value === Cell.torn));
  simulation.reset();
  assert.equal(simulation.snapshot().tearFailure, null);
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
  const snapshot = simulation.snapshot();
  assert.equal(snapshot.torn, true);
  assert.ok(snapshot.areaJump >= snapshot.releaseJumpThreshold);
  assert.deepEqual(snapshot.tearFailure, {
    kind: "area-jump",
    value: snapshot.areaJump,
    threshold: snapshot.releaseJumpThreshold,
  });
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

test("a large first lift can tear off a small piece at the grip", () => {
  const width = 72;
  const height = 36;
  const mask = rectangleMask(width, height, 3, 68, 6, 29);
  const grab = { x: 3 / 71, y: 18 / 35 };
  const simulation = new PeelSimulation(width, height, 41, 4, mask, 0.9, 0.09);
  simulation.begin(grab, 100);
  simulation.drag({ x: 0.48, y: grab.y }, 140);
  const { lastStep } = simulation.diagnostics();
  assert.equal(lastStep.previousPendingCells, 0);
  assert.equal(simulation.snapshot().tearFailure.kind, "area-jump");
  assert.equal(simulation.state[18 * width + 3], Cell.torn);
  assert.equal(simulation.state.filter(cell => cell === Cell.torn).length, lastStep.minimumPiece);
  assert.equal(simulation.state.filter(cell => cell === Cell.adhered).length, 66 * 24 - lastStep.minimumPiece);
});

test("settling a partial lift counts once and writes the released layer and mark", () => {
  const width = 52;
  const height = 30;
  const mask = rectangleMask(width, height, 3, 48, 5, 24);
  const simulation = new PeelSimulation(width, height, 9, 4, mask);
  simulation.begin({ x: 0.02, y: 0.5 }, 100);
  simulation.drag({ x: 0.28, y: 0.5 }, 400);
  assert.equal(simulation.snapshot().canCommit, true);
  const progress = simulation.snapshot().progress;
  assert.equal(simulation.end(), true);
  assert.equal(simulation.end(), false);
  assert.equal(simulation.snapshot().moves, 1);
  assert.equal(simulation.snapshot().progress, progress);
  const history = new Uint8Array(mask.length);
  const texture = new Uint8Array(mask.length * 4);
  simulation.writeReleaseHistory(history);
  simulation.writeTexture(texture);
  assert.ok(history.some(Boolean));
  assert.ok(history.every((value, index) => value === texture[index * 4 + 1]));
});

test("tear controls accept zero as a deliberate threshold", () => {
  const simulation = new PeelSimulation();
  simulation.setTearThreshold(0);
  simulation.setReleaseJumpThreshold(0);

  assert.equal(simulation.snapshot().tearThreshold, 0);
  assert.equal(simulation.snapshot().releaseJumpThreshold, 0);
});

test("finishing one figure over multiple moves removes it and preserves the other figure", () => {
  const width = 72;
  const height = 36;
  const left = rectangleMask(width, height, 3, 30, 6, 29);
  const right = rectangleMask(width, height, 48, 68, 6, 29);
  const mask = left.map((value, index) => value || right[index]);
  const simulation = new PeelSimulation(width, height, 41, 4, mask, 0.9);

  assert.equal(simulation.begin({ x: 0.02, y: 0.5 }, 100), true);
  simulation.drag({ x: 0.16, y: 0.5 }, 420);
  assert.equal(simulation.end(true), true);
  assert.ok(simulation.state.includes(Cell.released));
  simulation.setReleaseJumpThreshold(0.02);
  assert.equal(simulation.begin({ x: 0.08, y: 0.5 }, 700), true);
  simulation.drag({ x: 0.96, y: 0.5 }, 760);
  assert.ok(simulation.snapshot().areaJump > 0.02);
  assert.equal(simulation.snapshot().torn, false);
  assert.equal(simulation.snapshot().detached, true);
  const board = new Uint8Array(mask.length * 4);
  const dissolve = new Uint8Array(board.length);
  simulation.writeTexture(board);
  simulation.writeDetachedTexture(dissolve);
  for (let index = 0; index < mask.length; index++) {
    if (left[index]) {
      assert.deepEqual([...board.subarray(index * 4, index * 4 + 4)], [0, 0, 0, 0]);
      assert.equal(dissolve[index * 4 + 2], 255);
    }
    if (right[index]) assert.equal(board[index * 4], 255);
  }
  simulation.drag({ x: -0.1, y: 0.5 }, 780);
  assert.equal(simulation.snapshot().detached, true);
  assert.equal(simulation.snapshot().torn, false);
  assert.equal(simulation.end(true), true);
  for (let index = 0; index < mask.length; index++) {
    if (left[index]) assert.equal(simulation.state[index], Cell.outside);
    if (right[index]) assert.equal(simulation.state[index], Cell.adhered);
  }
  assert.equal(simulation.snapshot().progress, 28 / 49);
  assert.equal(simulation.snapshot().moves, 2);
  simulation.begin({ x: 0.1, y: 0.5 }, 800);
  simulation.drag({ x: 0.3, y: 0.5 }, 900);
  assert.equal(simulation.snapshot().pulling, false);
  assert.equal(simulation.end(true), false);

  simulation.begin({ x: 48 / (width - 1), y: 0.5 }, 1000);
  simulation.drag({ x: 1.35, y: 0.5 }, 1400);
  assert.equal(simulation.end(true), true);
  assert.ok(simulation.state.every(cell => cell === Cell.outside));
  assert.equal(simulation.snapshot().progress, 1);
  assert.equal(simulation.snapshot().complete, true);
  simulation.reset();
  assert.deepEqual(simulation.state, mask);
});

test("exceeding the move target still allows further peeling", () => {
  const width = 52;
  const height = 30;
  const mask = rectangleMask(width, height, 3, 48, 5, 24);
  const simulation = new PeelSimulation(width, height, 9, 1, mask, 1, 1);
  simulation.begin({ x: 0.02, y: 0.5 }, 100);
  simulation.drag({ x: 0.28, y: 0.5 }, 400);
  assert.equal(simulation.end(true), true);
  const history = new Uint8Array(mask.length);
  simulation.writeReleaseHistory(history);
  const firstRelease = history.slice();
  simulation.begin({ x: 0.16, y: 0.5 }, 700);
  simulation.drag({ x: 0.50, y: 0.5 }, 1000);
  assert.equal(simulation.end(true), true);
  assert.equal(simulation.snapshot().moves, 2);
  assert.equal(simulation.snapshot().complete, false);
  assert.equal(simulation.snapshot().failed, false);
  simulation.writeReleaseHistory(history);
  assert.ok(history.some((value, index) => value && !firstRelease[index]));
  assert.ok(firstRelease.every((value, index) => !value || history[index] === value));
  assert.deepEqual(history, simulation.state.map(cell => cell === Cell.released ? 255 : 0));
  assert.equal(simulation.begin({ x: 0.38, y: 0.5 }, 1300), true);
});

test("letting go while pulling outward saves the intact flap and its release marks", () => {
  const width = 52;
  const height = 30;
  const mask = rectangleMask(width, height, 3, 48, 5, 24);
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 0.9, 0.9);
  simulation.setTearFactors({ outward: 0.3, bottleneck: 0.52 });
  const history = new Uint8Array(mask.length);
  simulation.begin({ x: 0.02, y: 0.5 }, 100);
  simulation.drag({ x: 0.28, y: 0.5 }, 400);
  assert.equal(simulation.end(true), true);
  simulation.writeReleaseHistory(history);
  const firstRelease = history.slice();
  const progress = simulation.snapshot().progress;

  simulation.begin({ x: 0.16, y: 0.5 }, 700);
  simulation.drag({ x: 0.50, y: 0.5 }, 1000);
  assert.ok(simulation.snapshot().progress > progress);
  simulation.drag({ x: 0.46, y: 0.5 }, 1030);
  assert.equal(simulation.snapshot().outwardPulling, true);
  assert.equal(simulation.snapshot().canCommit, true);
  const heldProgress = simulation.snapshot().progress;
  const held = simulation.state.map(value => value === Cell.lifted ? 1 : 0);
  assert.equal(simulation.end(true), true);
  assert.equal(simulation.snapshot().progress, heldProgress);
  assert.ok(heldProgress > progress);
  assert.equal(simulation.snapshot().moves, 2);
  assert.equal(simulation.snapshot().torn, false);
  simulation.writeReleaseHistory(history);
  assert.ok(held.every((value, index) => !value || simulation.state[index] === Cell.released && history[index] === 255));
  assert.ok(firstRelease.every((value, index) => !value || history[index] === 255));
  assert.ok(history.some((value, index) => value && !firstRelease[index]));
});

test("pulling back softly stalls, while a strong reversal tears only the held flap", () => {
  const width = 52;
  const height = 30;
  const mask = rectangleMask(width, height, 3, 48, 5, 24);
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 0.24, 0.66);
  simulation.setTearFactors({ outward: 0.8, bottleneck: 0.85 });

  simulation.begin({ x: 0.02, y: 0.5 }, 100);
  simulation.drag({ x: -0.3, y: 0.5 }, 200);
  assert.equal(simulation.snapshot().progress, 0);
  assert.equal(simulation.snapshot().torn, false);
  assert.equal(simulation.end(true), false);

  simulation.begin({ x: 0.02, y: 0.5 }, 300);
  simulation.drag({ x: 0.28, y: 0.5 }, 500);
  const held = simulation.state.map(cell => cell === Cell.lifted ? 1 : 0);
  const progress = simulation.snapshot().progress;
  assert.ok(progress > 0 && progress < 1);
  const tensionRisk = simulation.tearWarning(null, 84);
  assert.ok(tensionRisk.risk > 0 && tensionRisk.risk < 1);
  assert.equal(tensionRisk.redirect, null);
  simulation.drag({ x: 0.26, y: 0.5 }, 530);
  assert.equal(simulation.snapshot().outwardPulling, true);
  assert.equal(simulation.snapshot().progress, progress);
  assert.equal(simulation.snapshot().torn, false);
  const outwardRisk = simulation.tearWarning(null, 84);
  assert.ok(outwardRisk.risk > 0 && outwardRisk.risk < 1);
  assert.ok(outwardRisk.redirect.x > 0);
  assert.deepEqual(simulation.tearWarning(83, 84), { risk: 83 / 84, redirect: null });

  simulation.drag({ x: 0.20, y: 0.5 }, 620);
  assert.equal(simulation.diagnostics().lastStep.outwardTear, true);
  assert.equal(simulation.snapshot().areaJump, 0);
  assert.equal(simulation.snapshot().tearDragging, true);
  assert.equal(simulation.tearWarning(83, 84), null);
  assert.deepEqual(simulation.state.map(cell => cell === Cell.torn ? 1 : 0), held);
  assert.ok(simulation.state.includes(Cell.adhered));
});

test("a previously released flap can be re-grabbed and torn by pulling outward", () => {
  const width = 52;
  const height = 30;
  const mask = rectangleMask(width, height, 3, 48, 5, 24);
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 0.24, 0.66);
  simulation.setTearFactors({ outward: 0.8, bottleneck: 0 });
  simulation.begin({ x: 0.02, y: 0.5 }, 100);
  simulation.drag({ x: 0.28, y: 0.5 }, 400);
  assert.equal(simulation.end(true), true);
  const flap = simulation.state.map(cell => cell === Cell.released ? 1 : 0);

  simulation.begin({ x: 0.16, y: 0.5 }, 500);
  simulation.drag({ x: 0.08, y: 0.5 }, 700);
  assert.equal(simulation.diagnostics().lastStep.outwardTear, true);
  assert.deepEqual(simulation.state.map(cell => cell === Cell.torn ? 1 : 0), flap);
  assert.ok(simulation.state.includes(Cell.adhered));
  assert.equal(simulation.end(true), false);
  assert.equal(simulation.snapshot().failed, true);
});

test("a diagonal tension tear carries the entire connected unglued flap", () => {
  const width = 52;
  const height = 30;
  const mask = rectangleMask(width, height, 3, 48, 5, 24);
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 0.9, 1);
  simulation.begin({ x: 0.02, y: 0.5 }, 100);
  simulation.drag({ x: 0.28, y: 0.5 }, 400);
  assert.equal(simulation.end(), true);
  const released = simulation.state.slice();

  simulation.setTearThreshold(0.012);
  simulation.begin({ x: 0.08, y: 0.31 }, 700);
  simulation.drag({ x: 0.31, y: 0.67 }, 900);
  assert.equal(simulation.snapshot().tearFailure?.kind, "tension");
  assert.ok(simulation.state.includes(Cell.adhered));
  assert.ok(released.every((value, index) => value !== Cell.released || simulation.state[index] === Cell.torn));
  assert.equal(simulation.diagnostics().current.releasedCells, 0);
  assert.ok(simulation.diagnostics().lastStep.carriedReleasedCells > 0);
});

test("a thin neck adds width-dependent tension independently of area jump", () => {
  const width = 128;
  const height = 70;
  const pull = (barWidth, bottleneck) => {
    const mask = Uint8Array.from({ length: width * height }, (_, index) => {
      const x = index % width;
      const y = Math.floor(index / width);
      const plates = Math.hypot(x - 26, y - 35) <= 20 || Math.hypot(x - 100, y - 35) <= 20;
      const bar = x >= 26 && x <= 100 && Math.abs(y - 35) <= barWidth / 2;
      return plates || bar ? 1 : 0;
    });
    const simulation = new PeelSimulation(width, height, 9, 4, mask, 0.66, 1);
    simulation.setTearFactors({ outward: 0, bottleneck });
    simulation.begin({ x: 6 / (width - 1), y: 35 / (height - 1) }, 100);
    let peak = 0;
    let frame = 0;
    while (++frame <= 220) {
      simulation.drag({ x: 6 / (width - 1) + frame / 100, y: 35 / (height - 1) }, 100 + frame * 60);
      const snapshot = simulation.snapshot();
      peak = Math.max(peak, simulation.diagnostics().lastStep.bottleneckLoad);
      if (snapshot.torn || snapshot.complete) break;
    }
    return { simulation, frame, peak };
  };

  const thin = pull(2, 0.85);
  const medium = pull(6, 0.85);
  const wide = pull(28, 0.85);
  const disabled = pull(2, 0);
  assert.equal(thin.simulation.snapshot().torn, true);
  assert.equal(thin.simulation.diagnostics().lastStep.stressTear, true);
  assert.equal(thin.simulation.diagnostics().lastStep.avalancheTear, false);
  assert.ok(thin.simulation.state.includes(Cell.adhered));
  assert.ok(thin.peak > medium.peak && thin.frame < medium.frame);
  assert.equal(wide.simulation.snapshot().complete, true);
  assert.equal(wide.simulation.snapshot().torn, false);
  assert.equal(disabled.peak, 0);
  assert.ok(disabled.frame > thin.frame);
});

test("thin neck tension finds a one-cell connection hidden by a nearby lobe", () => {
  const width = 100;
  const height = 84;
  const mask = Uint8Array.from({ length: width * height }, (_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const flap = x >= 5 && x <= 68 && y >= 10 && y <= 31;
    const anchor = x >= 12 && x <= 83 && y >= 39 && y <= 72;
    const connection = (y === 31 && x >= 68 && x <= 78) || (x === 78 && y >= 31 && y <= 39);
    return flap || anchor || connection ? 1 : 0;
  });
  const origin = { x: 5 / (width - 1), y: 20 / (height - 1) };
  const simulations = [0, 0.5, 1].map((bottleneck) => {
    const simulation = new PeelSimulation(width, height, 9, 4, mask, 0.4, 1);
    simulation.setTearFactors({ outward: 0, bottleneck });
    assert.equal(simulation.begin(origin, 100), true);
    return simulation;
  });
  const [off, half, full] = simulations;
  for (let frame = 1; frame <= 450 && !full.snapshot().torn; frame++) {
    for (const simulation of simulations) {
      simulation.drag({ x: origin.x + frame * 0.003, y: origin.y }, 100 + frame * 32);
    }
    assert.ok(off.snapshot().stress <= half.snapshot().stress);
    assert.ok(half.snapshot().stress <= full.snapshot().stress);
  }
  const step = full.diagnostics().lastStep;
  assert.equal(full.snapshot().tearFailure?.kind, "tension");
  assert.equal(step.frontCells, 1);
  assert.ok(step.bottleneckLoad >= 0.75);
  assert.ok(step.liftedCells >= 1408);
  assert.equal(off.snapshot().torn, false);
  assert.ok(full.state.includes(Cell.adhered));
});

test("maximum thin neck tension leaves a widening tip and a broad edge intact", () => {
  const width = 100;
  const height = 84;
  for (const tip of [false, true]) {
    const mask = Uint8Array.from({ length: width * height }, (_, index) => {
      const x = index % width;
      const y = Math.floor(index / width);
      const halfWidth = tip ? Math.min(20, Math.floor((x - 5) / 2)) : 20;
      return x >= 5 && x <= 83 && Math.abs(y - 40) <= halfWidth ? 1 : 0;
    });
    const simulation = new PeelSimulation(width, height, 9, 4, mask, 0.4, 1);
    simulation.setTearFactors({ outward: 0, bottleneck: 1 });
    const origin = { x: 5 / (width - 1), y: 40 / (height - 1) };
    assert.equal(simulation.begin(origin, 100), true);
    for (let frame = 1; frame <= 600 && !simulation.snapshot().complete; frame++) {
      simulation.drag({ x: origin.x + frame * 0.003, y: origin.y }, 100 + frame * 32);
      assert.equal(simulation.diagnostics().lastStep.bottleneckLoad, 0);
      assert.equal(simulation.snapshot().torn, false);
    }
    assert.equal(simulation.snapshot().complete, true);
  }
});

test("tiny reversals keep measuring and loading a thin neck", () => {
  const width = 128;
  const height = 70;
  const mask = Uint8Array.from({ length: width * height }, (_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    return Math.hypot(x - 26, y - 35) <= 20 || Math.hypot(x - 100, y - 35) <= 20
      || (x >= 26 && x <= 100 && Math.abs(y - 35) <= 1) ? 1 : 0;
  });
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 1, 1);
  simulation.setTearFactors({ outward: 0.8, bottleneck: 0.85 });
  const origin = { x: 6 / (width - 1), y: 35 / (height - 1) };
  simulation.begin(origin, 100);
  for (let frame = 1; frame <= 46; frame++) {
    simulation.drag({ x: origin.x + frame / 100, y: origin.y }, 100 + frame * 60);
  }
  assert.ok(simulation.diagnostics().lastStep.bottleneckLoad > 0.6);
  const stress = simulation.snapshot().stress;

  simulation.drag({ x: origin.x + 0.46 - 0.0001, y: origin.y }, 2876);
  assert.equal(simulation.snapshot().outwardPulling, false);
  assert.ok(simulation.diagnostics().lastStep.bottleneckLoad > 0.6);
  assert.ok(simulation.snapshot().stress > stress);

  simulation.setTearThreshold(simulation.snapshot().stress + 0.001);
  simulation.drag({ x: origin.x + 0.46 - 0.0002, y: origin.y }, 2892);
  assert.equal(simulation.snapshot().tearFailure?.kind, "tension");
  assert.ok(simulation.state.includes(Cell.adhered));
});

test("small reversal steps accumulate into an outward pull", () => {
  const width = 52;
  const height = 30;
  const mask = rectangleMask(width, height, 3, 48, 5, 24);
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 0.9, 1);
  simulation.setTearFactors({ outward: 0.8, bottleneck: 0.85 });
  simulation.begin({ x: 0.02, y: 0.5 }, 100);
  simulation.drag({ x: 0.28, y: 0.5 }, 400);
  simulation.drag({ x: 0.275, y: 0.5 }, 416);
  assert.equal(simulation.snapshot().outwardPulling, false);
  assert.ok(simulation.diagnostics().lastStep.frontCells > 0);

  simulation.drag({ x: 0.270, y: 0.5 }, 432);
  simulation.drag({ x: 0.265, y: 0.5 }, 448);
  assert.equal(simulation.snapshot().outwardPulling, true);
  assert.equal(simulation.snapshot().torn, false);
  simulation.drag({ x: 0.28, y: 0.5 }, 464);
  assert.equal(simulation.snapshot().outwardPulling, false);
  assert.ok(simulation.diagnostics().lastStep.frontCells > 0);
});

test("continuing a pull once the flap starts stretching quickly tears the flap", () => {
  const width = 64;
  const height = 40;
  const threshold = 0.66;
  const mask = rectangleMask(width, height, 3, 60, 18, 21);
  const simulation = new PeelSimulation(width, height, 9, 4, mask, threshold, 1);
  simulation.begin({ x: 0.02, y: 0.5 }, 100);
  let stretchFrame = 0;
  let tearFrame = 0;
  for (let frame = 1; frame < 60; frame++) {
    simulation.drag({ x: 0.02 + frame / 100, y: 0.5 }, 100 + frame * 60);
    const snapshot = simulation.snapshot();
    if (snapshot.torn) {
      tearFrame = frame;
      break;
    }
    if (snapshot.stress >= threshold * 0.9 && !stretchFrame) stretchFrame = frame;
  }
  assert.ok(stretchFrame > 0 && tearFrame > stretchFrame && tearFrame - stretchFrame <= 5);
  assert.ok(simulation.diagnostics().lastStep.targetStress < threshold);
  assert.equal(simulation.snapshot().tearDragging, true);
  assert.ok(simulation.state.includes(Cell.adhered));
});

test("a held grip loads progressively with screen-space separation and tears at the cap", () => {
  const width = 52;
  const height = 30;
  const mask = rectangleMask(width, height, 3, 48, 5, 24);
  const sample = (gap) => {
    const simulation = new PeelSimulation(width, height, 9, 4, mask, 1, 1);
    simulation.begin({ x: 3 / 51, y: 0.5 }, 100);
    simulation.drag({ x: 0.3, y: 0.5 }, 400);
    const initial = simulation.snapshot();
    assert.ok(initial.progress > 0 && !initial.detached && !initial.torn);
    const contact = { x: 0.35, y: 0.6 };
    simulation.applyGripGap(gap, 84, contact);
    const after = simulation.snapshot();
    return { simulation, gapStress: after.stress - initial.stress, after, contact };
  };

  assert.equal(sample(20).gapStress, 0);
  const near = sample(81);
  assert.ok(near.gapStress > 2 * sample(51).gapStress);
  assert.equal(near.after.torn, false);

  const { simulation, after, contact } = sample(84);
  assert.deepEqual(after.tearFailure, { kind: "grip-gap", value: 84, threshold: 84 });
  assert.ok(simulation.state.includes(Cell.adhered));
  assert.ok(simulation.state.includes(Cell.torn));
  assert.deepEqual(after.tornOffset, { x: contact.x - after.grab.x, y: contact.y - after.grab.y });
  simulation.drag({ x: 0.4, y: 0.5 }, 500);
  assert.ok(simulation.snapshot().tornOffset.x > after.tornOffset.x);
});

test("a grip gap cannot tear a fully unglued sticker", () => {
  const width = 52;
  const height = 30;
  const mask = rectangleMask(width, height, 8, 20, 12, 18);
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 1, 1);
  simulation.begin({ x: 8 / 51, y: 0.5 }, 100);
  simulation.drag({ x: 0.9, y: 0.5 }, 400);
  assert.equal(simulation.snapshot().detached, true);
  assert.equal(simulation.tearWarning(83, 84), null);
  assert.equal(simulation.applyGripGap(100, 84, null), false);
  assert.equal(simulation.end(), true);
});

test("a sharp raster tip cannot detach as its own piece", () => {
  const width = 24;
  const height = 24;
  const mask = rectangleMask(width, height, 3, 17, 6, 18);
  const speck = 5 * width + 2;
  mask[speck] = 1;
  mask.fill(1, 22 * width + 8, 22 * width + 14);
  removeStickerSpecks(mask, width);

  assert.equal(mask[speck], 0);
  assert.equal(mask[6 * width + 3], 1);
  assert.equal(mask[22 * width + 8], 1);
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 1, 1);
  simulation.begin({ x: 2 / 23, y: 5 / 23 }, 100);
  assert.equal(simulation.diagnostics().current.grabIndex, 6 * width + 3);
  simulation.drag({ x: 6 / 23, y: 8 / 23 }, 240);
  assert.equal(simulation.snapshot().detached, false);
});

test("a shallow flap stays attached when the area-jump or grip cap fires below the minimum tear size", () => {
  const width = 208;
  const height = 208;
  const mask = rectangleMask(width, height, 20, 187, 60, 149);
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 1, 0);
  const y = 104 / 207;
  simulation.begin({ x: 20 / 207, y }, 100);
  simulation.drag({ x: 21 / 207, y }, 180);

  const { current, lastStep } = simulation.diagnostics();
  assert.ok(current.liftedCells > 0 && current.liftedCells < lastStep.minimumPiece);
  assert.ok(simulation.snapshot().areaJump > 0);
  assert.equal(simulation.applyGripGap(120, 84, null), false);
  assert.equal(simulation.snapshot().torn, false);
  assert.equal(simulation.state.includes(Cell.torn), false);

  simulation.setReleaseJumpThreshold(1);
  simulation.drag({ x: 0.24, y }, 480);
  assert.equal(simulation.applyGripGap(120, 84, null), true);
  assert.equal(simulation.snapshot().tearFailure.kind, "grip-gap");
  assert.ok(simulation.state.filter(cell => cell === Cell.torn).length >= lastStep.minimumPiece);
});

test("sustained outward load can reach a 29% tear threshold at 14% sensitivity", () => {
  const width = 52;
  const height = 30;
  const mask = rectangleMask(width, height, 3, 48, 5, 24);
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 0.29, 0.66);
  simulation.setTearFactors({ outward: 0.14, bottleneck: 0.85 });
  simulation.begin({ x: 0.02, y: 0.5 }, 100);
  simulation.drag({ x: 0.28, y: 0.5 }, 400);
  for (let frame = 1; frame <= 40; frame++) {
    simulation.drag({ x: 0.17 - frame * 0.001, y: 0.5 }, 400 + frame * 50);
    if (frame === 1) assert.equal(simulation.snapshot().torn, false);
    if (simulation.snapshot().torn) break;
  }
  assert.equal(simulation.diagnostics().lastStep.outwardTear, true);
  const failure = simulation.snapshot().tearFailure;
  assert.equal(failure.kind, "outward");
  assert.equal(failure.threshold, 0.29);
  assert.ok(failure.value >= failure.threshold);
  assert.ok(simulation.state.includes(Cell.adhered));
  assert.ok(simulation.state.includes(Cell.torn));
});

test("the release mark follows a flap through re-grab and tear until reset", () => {
  const width = 52;
  const height = 30;
  const mask = rectangleMask(width, height, 3, 48, 5, 24);
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 0.24, 0.66);
  simulation.setTearFactors({ outward: 0.8, bottleneck: 0 });
  const history = new Uint8Array(mask.length);

  simulation.begin({ x: 0.02, y: 0.5 }, 100);
  simulation.drag({ x: 0.28, y: 0.5 }, 400);
  simulation.writeReleaseHistory(history);
  assert.ok(!history.some(Boolean), "an uncommitted lift should leave no dark mark");
  assert.equal(simulation.releasedGrips.size, 0);
  assert.equal(simulation.end(true), true);
  const expected = simulation.state.map(cell => cell === Cell.released ? 255 : 0);
  simulation.writeReleaseHistory(history);
  assert.deepEqual(history, expected);
  assert.equal(simulation.releasedGrips.size, 1);
  const [gripIndex, direction] = [...simulation.releasedGrips][0];
  assert.equal(expected[gripIndex], 255);
  assert.ok(direction.x > 0.95);

  simulation.begin({ x: 0.16, y: 0.5 }, 500);
  simulation.drag({ x: 0.145, y: 0.5 }, 550);
  assert.ok(simulation.state.some((cell, index) => cell === Cell.lifted && expected[index]));
  simulation.writeReleaseHistory(history);
  assert.deepEqual(history, expected);
  simulation.drag({ x: 0.08, y: 0.5 }, 700);
  assert.equal(simulation.snapshot().torn, true);
  simulation.end(true);
  simulation.writeReleaseHistory(history);
  assert.deepEqual(history, expected);

  simulation.reset();
  simulation.writeReleaseHistory(history);
  assert.ok(!history.some(Boolean));
  assert.equal(simulation.releasedGrips.size, 0);
});

test("the leading rim clicks on the step it clears even while the rest of the sticker is attached", () => {
  const width = 96;
  const height = 80;
  const mask = rectangleMask(width, height, 8, 55, 18, 60);
  for (let y = 41; y <= 60; y++) mask.fill(1, y * width + 56, y * width + 86);
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 1, 1);
  const start = { x: 8 / (width - 1), y: 29 / (height - 1) };
  const rim = [27, 28, 29, 30, 31].map(y => y * width + 55);
  const total = mask.reduce((sum, value) => sum + value, 0);
  let clicks = 0;
  simulation.begin(start, 100);
  for (let tick = 1; tick <= 240; tick++) {
    const before = simulation.state.slice();
    const feedback = simulation.drag({ ...start, x: start.x + tick * 0.008 }, 100 + tick * 40);
    const freed = simulation.state.reduce((sum, cell, index) =>
      sum + (cell === Cell.lifted && before[index] === Cell.adhered ? 1 : 0), 0);
    assert.equal(feedback?.releasedFraction ?? 0, freed / total);
    if (feedback?.edgeReleased) {
      clicks++;
      assert.ok(rim.some(index => before[index] === Cell.adhered));
      assert.ok(rim.every(index => simulation.state[index] === Cell.lifted));
      assert.equal(simulation.state[50 * width + 85], Cell.adhered);
      assert.equal(simulation.snapshot().detached, false);
    }
    if (simulation.snapshot().detached) break;
  }
  assert.equal(clicks, 1);
  assert.equal(simulation.snapshot().detached, true);
});

test("a straight sweep that clears the whole rim in one step emits a completion click", () => {
  const width = 52;
  const height = 30;
  const mask = rectangleMask(width, height, 3, 34, 8, 20);
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 1, 1);
  simulation.begin({ x: 3 / (width - 1), y: 14 / (height - 1) }, 100);
  assert.equal(simulation.drag({ x: 0.01, y: 14 / (height - 1) }, 150)?.edgeReleased ?? false, false);
  const completed = simulation.drag({ x: 1.8, y: 14 / (height - 1) }, 510);
  assert.equal(simulation.snapshot().detached, true);
  assert.equal(completed?.edgeReleased, true);
  assert.equal(simulation.drag({ x: 1.9, y: 14 / (height - 1) }, 525), undefined);
});

test("a cutout stays silent until the sweep frees a new outer rim", () => {
  const width = 68;
  const height = 42;
  const mask = rectangleMask(width, height, 4, 61, 8, 33);
  for (let y = 16; y <= 25; y++) mask.fill(0, y * width + 23, y * width + 39);
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 1, 1);
  const y = 20 / (height - 1);
  const start = 4 / (width - 1);
  const innerRim = 20 * width + 22;
  const outerRim = [18, 19, 20, 21, 22].map(row => row * width + 61);
  let crossedCutout = false;
  let clicks = 0;
  simulation.begin({ x: start, y }, 100);
  for (let tick = 1; tick <= 220; tick++) {
    const wasAttached = outerRim.some(cell => simulation.state[cell] === Cell.adhered);
    const feedback = simulation.drag({ x: start + tick * 0.008, y }, 100 + tick * 40);
    const outerFree = outerRim.every(cell => simulation.state[cell] === Cell.lifted);
    if (!outerFree && simulation.state[innerRim] === Cell.lifted) {
      crossedCutout = true;
      assert.equal(feedback?.edgeReleased, false);
    }
    if (feedback?.edgeReleased) {
      clicks++;
      assert.ok(crossedCutout && wasAttached && outerFree);
    }
    if (simulation.snapshot().detached) break;
  }
  assert.equal(clicks, 1);
});

test("detaching toward a previously released rim does not click", () => {
  const width = 68;
  const height = 42;
  const mask = rectangleMask(width, height, 4, 61, 8, 33);
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 1, 1);
  const y = 20 / (height - 1);
  const right = 61 / (width - 1);
  simulation.begin({ x: right, y }, 100);
  for (let tick = 1; tick <= 40; tick++) {
    assert.equal(simulation.drag({ x: right - tick * 0.008, y }, 100 + tick * 40)?.edgeReleased, false);
  }
  assert.equal(simulation.end(), true);
  assert.equal(simulation.state[20 * width + 61], Cell.released);

  const left = 4 / (width - 1);
  simulation.begin({ x: left, y }, 2000);
  for (let tick = 1; tick <= 220 && !simulation.snapshot().detached; tick++) {
    assert.equal(simulation.drag({ x: left + tick * 0.008, y }, 2000 + tick * 40)?.edgeReleased, false);
  }
  assert.equal(simulation.snapshot().detached, true);
});
