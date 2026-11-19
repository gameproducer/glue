import test from "node:test";
import assert from "node:assert/strict";
import { nearestStateSources, extendStateTexture, writeCurlDistances } from "../lib/render/StateTexture.ts";

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
  writeCurlDistances(state, distances, labels.length);
  assert.deepEqual([...distances], [255, 2, 1, 0, 1, 2, 255, 1, 0]);
});
