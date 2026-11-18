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

test("finishing one figure over multiple moves removes it and preserves the other figure", () => {
  const width = 72;
  const height = 36;
  const left = rectangleMask(width, height, 3, 30, 6, 29);
  const right = rectangleMask(width, height, 48, 68, 6, 29);
  const mask = left.map((value, index) => value || right[index]);
  const simulation = new PeelSimulation(width, height, 41, 4, mask, 0.9, 0.02);

  assert.equal(simulation.begin({ x: 0.02, y: 0.5 }, 100), true);
  simulation.drag({ x: 0.16, y: 0.5 }, 420);
  assert.equal(simulation.end(true), true);
  assert.ok(simulation.state.includes(Cell.released));
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
  simulation.begin({ x: 0.16, y: 0.5 }, 700);
  simulation.drag({ x: 0.50, y: 0.5 }, 1000);
  assert.equal(simulation.end(true), true);
  assert.equal(simulation.snapshot().moves, 2);
  assert.equal(simulation.snapshot().complete, false);
  assert.equal(simulation.snapshot().failed, false);
  assert.equal(simulation.begin({ x: 0.38, y: 0.5 }, 1300), true);
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
  simulation.drag({ x: 0.26, y: 0.5 }, 530);
  assert.equal(simulation.snapshot().outwardPulling, true);
  assert.equal(simulation.snapshot().progress, progress);
  assert.equal(simulation.snapshot().torn, false);

  simulation.drag({ x: 0.20, y: 0.5 }, 620);
  assert.equal(simulation.diagnostics().lastStep.outwardTear, true);
  assert.equal(simulation.snapshot().areaJump, 0);
  assert.equal(simulation.snapshot().tearDragging, true);
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
  assert.equal(simulation.end(true), true);
  const expected = simulation.state.map(cell => cell === Cell.released ? 255 : 0);
  simulation.writeReleaseHistory(history);
  assert.deepEqual(history, expected);

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
});
