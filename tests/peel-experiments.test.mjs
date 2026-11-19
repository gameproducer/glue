import test from "node:test";
import assert from "node:assert/strict";
import { Cell, PeelSimulation } from "../lib/peel/PeelSimulation.ts";
import { ElasticPeel } from "../lib/peel/ElasticPeel.ts";
import { SurfaceField, SURFACE_OPTIONS, surfaceResistance } from "../lib/peel/SurfaceField.ts";

const width = 96;
const height = 72;
const start = { x: 10 / (width - 1), y: 35 / (height - 1) };
const sheet = new Uint8Array(width * height);
for (let y = 18; y <= 50; y++) sheet.fill(1, y * width + 10, y * width + 83);

function makeSimulation(elasticity, surface, mask = sheet) {
  const simulation = new PeelSimulation(width, height, 9, 4, mask, 0.66, 0.33);
  simulation.setTearFactors({ outward: 0.05, bottleneck: 0.05 });
  simulation.setExperiments(elasticity, surface);
  return simulation;
}

function sweep(elasticity, surface, samples = 75) {
  const simulation = makeSimulation(elasticity, surface);
  simulation.begin(start, 100);
  for (let i = 1; i <= samples; i++) {
    simulation.drag({ x: start.x + 0.51 * i / samples, y: start.y }, 100 + 2000 * i / samples);
  }
  return simulation;
}

test("elasticity loads the held flap before the front yields and recovers on release", () => {
  const simulation = makeSimulation(1, "off");
  simulation.begin(start, 100);
  let lastProgress = 0;
  let lastOffset = 0;
  let sawStationaryFront = false;
  for (let i = 1; i <= 35; i++) {
    simulation.drag({ x: start.x + i * 0.0025, y: start.y }, 100 + 20 * i);
    const { progress } = simulation.snapshot();
    const offset = simulation.elasticPeel.displacement.x;
    if (progress > 0 && progress === lastProgress && offset > lastOffset + 0.001) sawStationaryFront = true;
    lastProgress = progress;
    lastOffset = offset;
  }
  assert.ok(sawStationaryFront);
  assert.ok(lastOffset > 0.015);
  assert.ok(simulation.diagnostics().lastStep.elasticReaction > 0);
  const weights = simulation.elasticPeel.weights;
  assert.ok(weights.some(weight => weight > 0 && weight < 255));
  for (let i = 0; i < weights.length; i++) {
    if (weights[i]) assert.equal(simulation.state[i], Cell.lifted);
  }

  const progressBeforePause = simulation.snapshot().progress;
  const pointer = simulation.snapshot().pointer;
  simulation.drag(pointer, 1800);
  assert.equal(simulation.snapshot().progress, progressBeforePause);
  simulation.end();
  assert.deepEqual(simulation.elasticPeel.displacement, { x: 0, y: 0 });
  assert.ok(simulation.elasticPeel.weights.every(value => value === 0));
});

test("a narrow spring cross section takes more strain than a broad cross section", () => {
  const ribbon = new Uint8Array(width * height);
  for (let x = 12; x <= 67; x++) {
    for (let y = 20; y <= 48; y++) {
      const neck = x >= 32 && x <= 43;
      if (!neck || y >= 33 && y <= 35) ribbon[y * width + x] = x === 67 ? Cell.adhered : Cell.lifted;
    }
  }
  const spring = new ElasticPeel(width, height);
  spring.rebuild(ribbon, 34 * width + 12);
  spring.deform(0.08, 0, { x: 1, y: 0 }, 1);
  const gradient = x => Math.abs(spring.weights[34 * width + x] - spring.weights[34 * width + x + 1]);
  assert.ok(gradient(37) > gradient(54));
  assert.ok(spring.peakStrain > 0);
  assert.equal(spring.weights[34 * width + 66], 0);
});

test("a tear keeps the deformed fragment and leaves adhered material on the board", () => {
  const simulation = sweep(0.65, "dome");
  const displacement = { ...simulation.elasticPeel.displacement };
  assert.ok(displacement.x > 0);
  assert.ok(simulation.applyGripGap(84, 84, null));
  assert.deepEqual(simulation.elasticPeel.displacement, displacement);
  assert.ok(simulation.state.includes(Cell.torn));
  assert.ok(simulation.state.includes(Cell.adhered));
  assert.equal(simulation.end(), false);
  assert.deepEqual(simulation.elasticPeel.displacement, displacement);
  simulation.reset();
  assert.deepEqual(simulation.elasticPeel.displacement, { x: 0, y: 0 });
});

test("the six height fields are bounded and change opening load with the pull direction", () => {
  const fields = SURFACE_OPTIONS.map(([kind]) => new SurfaceField(kind, width / height));
  assert.ok(fields[0].pixels.every(value => value === 0));
  assert.ok(fields[3].height(0.5, 0.5) > 0.1);
  assert.ok(fields[4].height(0.5, 0.5) < -0.1);
  assert.ok(fields[5].height(0.25, 0.5) > 0 && fields[5].height(0.75, 0.5) < 0);
  for (const field of fields) {
    assert.equal(field.height(-0.5, 0.5), 0);
    assert.equal(field.height(0.5, 1.5), 0);
    const slope = field.gradient(0.38, 0.48);
    assert.ok(Number.isFinite(slope.x) && Number.isFinite(slope.y));
  }
  const ridgeSlope = fields[1].gradient(0.4, 0.5).x;
  assert.ok(surfaceResistance(ridgeSlope, 0, 0.3) > surfaceResistance(-ridgeSlope, 0, 0.3));
  assert.ok(surfaceResistance(0, -0.05, 0.3) > surfaceResistance(0, 0.05, 0.3));
});

test("each surface advances the existing front with and without elasticity", () => {
  const baseline = sweep(0, "off").snapshot();
  const elasticFlat = sweep(0.65, "off").snapshot();
  assert.ok(elasticFlat.progress < baseline.progress);
  for (const [surface] of SURFACE_OPTIONS.slice(1)) {
    const rigid = sweep(0, surface);
    const elastic = sweep(0.65, surface);
    for (const simulation of [rigid, elastic]) {
      const { progress, tearFailure } = simulation.snapshot();
      assert.ok(progress > 0.12, surface);
      assert.equal(tearFailure, null, surface);
      assert.ok(Number.isFinite(simulation.diagnostics().lastStep.surfaceLoad), surface);
    }
    assert.notEqual(rigid.snapshot().progress, baseline.progress, surface);
    assert.notEqual(elastic.snapshot().progress, rigid.snapshot().progress, surface);
  }
});

test("subdividing the same experimental drag leaves the solver and material pose equivalent", () => {
  for (const elasticity of [0, 0.7]) {
    const coarse = sweep(elasticity, "diagonal", 25);
    const fine = sweep(elasticity, "diagonal", 125);
    assert.deepEqual(coarse.state, fine.state);
    assert.equal(coarse.snapshot().progress, fine.snapshot().progress);
    assert.ok(Math.abs(coarse.snapshot().stress - fine.snapshot().stress) < 1e-6);
    if (elasticity) assert.deepEqual(coarse.elasticPeel.weights, fine.elasticPeel.weights);
  }
});

test("repeated grip checks do not compound the same experimental load", () => {
  const simulation = sweep(0.7, "diagonal");
  assert.equal(simulation.applyGripGap(71, 84, null), false);
  const measured = simulation.snapshot().stress;
  for (let i = 0; i < 10; i++) assert.equal(simulation.applyGripGap(71, 84, null), false);
  assert.equal(simulation.snapshot().stress, measured);
});

test("holes and other pieces retain their identity during a combined experiment", () => {
  const mask = sheet.slice();
  for (let y = 28; y <= 40; y++) mask.fill(0, y * width + 29, y * width + 43);
  for (let y = 4; y < 11; y++) mask.fill(1, y * width + 42, y * width + 58);
  const simulation = makeSimulation(0.8, "waves", mask);
  simulation.begin(start, 100);
  for (let i = 1; i <= 70; i++) simulation.drag({ x: start.x + i * 0.007, y: start.y }, 100 + i * 30);
  assert.ok(simulation.snapshot().progress > 0);
  assert.equal(simulation.state[35 * width + 34], Cell.outside);
  assert.equal(simulation.state[7 * width + 45], Cell.adhered);
  assert.ok(simulation.end());
  assert.ok(simulation.state.includes(Cell.released));
  simulation.setExperiments(0, "off");
  simulation.reset();
  assert.deepEqual(simulation.state, mask);
  assert.equal(simulation.snapshot().moves, 0);
  assert.equal(simulation.elasticPeel, null);
  assert.equal(simulation.surface, null);
});
