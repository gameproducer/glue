import test from "node:test";
import assert from "node:assert/strict";
import { nearestStateSources, extendStateTexture, writeCurlDistances } from "../lib/render/StateTexture.ts";
import { AttachedCurl } from "../lib/render/AttachedCurl.ts";

test("coarse silhouette and hole cells inherit a layer without modifying simulation", () => {
  const state = new Uint8Array([0, 1, 0, 1, 0, 1, 0, 1, 0]);
  const original = state.slice();
  const sources = nearestStateSources(state, 3, 3);
  const texture = new Uint8Array(36);
  for (let i = 0; i < state.length; i++) if (state[i]) texture[i * 4] = 255;
  extendStateTexture(texture, sources);
  for (let i = 0; i < state.length; i++) assert.equal(texture[i * 4], 255);
  assert.deepEqual(state, original);
  // All current physical cells move to the lifted layer. Outside labels must
  // track that change instead of leaving a stationary rim at the PNG edge.
  texture.fill(0);
  for (let i = 0; i < state.length; i++) if (state[i]) texture[i * 4 + 2] = 255;
  extendStateTexture(texture, sources);
  for (let i = 0; i < state.length; i++) {
    assert.equal(texture[i * 4], 0);
    assert.equal(texture[i * 4 + 2], 255);
  }
});

test("internal layer boundaries and empty artwork remain intact", () => {
  const sources = nearestStateSources(new Uint8Array([0, 1, 2, 0]), 4, 1);
  const texture = new Uint8Array([0,0,0,0, 255,0,0,0, 0,255,0,0, 0,0,0,0]);
  extendStateTexture(texture, sources);
  assert.deepEqual([...texture], [255,0,0,0, 255,0,0,0, 0,255,0,0, 0,255,0,0]);
  const empty = new Uint8Array(8);
  extendStateTexture(empty, nearestStateSources(new Uint8Array(2), 2, 1));
  assert.deepEqual([...empty], Array(8).fill(0));
});

test("the curl anchors to both kinds of flat material and skips gaps in the artwork", () => {
  const labels = [0, 3, 3, 1, 3, 3, 0, 3, 2];
  const state = new Uint8Array(labels.length * 4);
  labels.forEach((label, index) => { if (label) state[index * 4 + label - 1] = 255; });
  const distances = new Uint8Array(labels.length);
  writeCurlDistances(state, distances, labels.length, new Int32Array(labels.length));
  assert.deepEqual([...distances], [255, 2, 1, 0, 1, 2, 255, 1, 0]);
});

test("curl distances follow a folded-back route without a jump between adjacent cells", () => {
  const rows = ["FLLL", "...L", "LLLL", "L...", "LLLL"];
  const labels = rows.join("");
  const state = new Uint8Array(labels.length * 4);
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === "F") state[i * 4] = 255;
    if (labels[i] === "L") state[i * 4 + 2] = 255;
  }
  const distances = new Uint8Array(labels.length);
  writeCurlDistances(state, distances, rows[0].length, new Int32Array(labels.length));
  assert.deepEqual([...distances], [0, 1, 2, 3, 255, 255, 255, 4, 8, 7, 6, 5, 9, 255, 255, 255, 10, 11, 12, 13]);
});

test("an off-axis seam limits extension while a straight fold keeps its original curl", () => {
  const width = 60;
  const height = 10;
  const size = width * height;
  const state = new Uint8Array(size * 4);
  const seam = new Uint8Array(size);
  const curl = new AttachedCurl(width, height, 6, 1, Int32Array.from({ length: size }, (_, i) => i));
  const radius = 0.32;
  const halfTurn = Math.PI * radius;
  const shift = depth => depth >= halfTurn ? 2 * depth - halfTurn : depth - radius * Math.sin(depth / radius);
  const sample = (col, grab, depth) => {
    const x = (col + 0.5) / width;
    return curl.sampleDepth({ x, y: 0.55 }, Math.max(0, depth - (x - 0.5) * 6 + grab));
  };
  const run = (flatColumn, grab, depth) => {
    state.fill(0);
    for (let i = 0; i < size; i++) state[i * 4 + (i % width === flatColumn ? 0 : 2)] = 255;
    writeCurlDistances(state, seam, width, new Int32Array(size));
    curl.update(state, seam, { x: grab, y: 0 }, { x: 1, y: 0 }, depth, radius, false);
  };

  run(0, 2.95, 2);
  assert.ok(sample(1, 2.95, 2) < 0.002);
  const extension = sample(40, 2.95, 2);
  assert.ok(extension > 0.5);
  assert.ok(shift(extension) <= (40 - 1) * 0.1 * 0.16 + 0.001);

  run(width - 1, -2.95, 5.7);
  assert.equal(sample(58, -2.95, 5.7), 0);
  assert.ok(Math.abs(sample(10, -2.95, 5.7) - 4.7) < 0.001);
});

test("a smooth free curl continues across artwork pixels outside the simulation mask", () => {
  const width = 60;
  const height = 10;
  const size = width * height;
  const mask = new Uint8Array(size);
  const state = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const col = i % width;
    if (col < 2) continue;
    mask[i] = 1;
    state[i * 4 + (col === width - 1 ? 0 : 2)] = 255;
  }
  const seam = new Uint8Array(size);
  writeCurlDistances(state, seam, width, new Int32Array(size));
  const curl = new AttachedCurl(width, height, 6, 1, nearestStateSources(mask, width, height));
  curl.update(state, seam, { x: -2.75, y: 0 }, { x: 1, y: 0 }, 5.5, 0.32, false);
  for (const col of [0, 1]) {
    const x = (col + 0.5) / width;
    const nominal = 5.5 - (x - 0.5) * 6 - 2.75;
    assert.equal(curl.sampleDepth({ x, y: 0.55 }, nominal), nominal);
  }
});
