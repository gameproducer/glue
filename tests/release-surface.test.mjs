import test from "node:test";
import assert from "node:assert/strict";
import { detachedAlignmentDuration, detachedAnimation, releaseSettleDuration, writeReleaseSurface } from "../lib/render/ReleaseSurface.ts";
import { nearestStateSources } from "../lib/render/StateTexture.ts";

test("released relief bevels into the adhesive and curls locally around old grips", () => {
  const width = 32;
  const height = 24;
  const sticker = new Uint8Array(width * height).fill(1);
  const index = (x, y) => y * width + x;
  const history = new Uint8Array(sticker.length);
  for (let y = 0; y < height; y++) history.fill(255, index(0, y), index(16, y));
  const target = new Uint8Array(history.length * 4);
  const grips = new Map([[index(5, 12), { x: 1, y: 0 }]]);
  writeReleaseSurface(target, history, nearestStateSources(sticker, width, height), width, grips);
  const sample = (x, y, channel) => target[index(x, y) * 4 + channel];

  assert.equal(sample(15, 12, 0), 255);
  assert.equal(sample(16, 12, 0), 0);
  assert.ok(sample(15, 12, 1) < sample(13, 12, 1));
  assert.ok(sample(13, 12, 1) < sample(10, 12, 1));
  assert.ok(sample(5, 12, 2) > 200);
  assert.ok(sample(2, 12, 2) > sample(8, 12, 2));
  assert.equal(sample(5, 1, 2), 0);
  assert.equal(sample(16, 12, 2), 0);
});

test("small releases settle in about half a second and larger pieces take up to one second", () => {
  assert.equal(releaseSettleDuration(0, 100), 500);
  assert.equal(releaseSettleDuration(1, 100), 550);
  assert.equal(releaseSettleDuration(25, 100), 750);
  assert.equal(releaseSettleDuration(100, 100), 1000);
});

test("detached material aligns 75% faster while held and fades once released and aligned", () => {
  const detachedAt = 1000;
  const duration = detachedAlignmentDuration(25, 100);
  assert.equal(duration * 1.75, releaseSettleDuration(25, 100));
  assert.deepEqual(detachedAnimation(detachedAt, detachedAt, null, duration), { alignment: 0, fadeStart: null });
  assert.ok(Math.abs(detachedAnimation(detachedAt + duration / 2, detachedAt, null, duration).alignment - 0.5) < 1e-8);
  assert.deepEqual(detachedAnimation(2400, detachedAt, null, duration), { alignment: 1, fadeStart: null });
  assert.equal(detachedAnimation(2400, detachedAt, 2300, duration).fadeStart, 2300);
  assert.equal(detachedAnimation(1300, detachedAt, 1200, duration).fadeStart, detachedAt + duration);
});
