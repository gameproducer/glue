import test from "node:test";
import assert from "node:assert/strict";
import { stickerLayout } from "../lib/peel/StickerLayout.ts";
import { fitFrustum, stepCamera } from "../lib/render/PeelFraming.ts";
import { MAX_MANUAL_ZOOM, moveManualView } from "../lib/render/TouchCamera.ts";

test("focus picks filled cells and ignores ambiguous gaps and released pieces", () => {
  const width = 12;
  const height = 8;
  const mask = new Uint8Array(width * height);
  for (let y = 2; y < 6; y++) {
    mask.fill(1, y * width + 1, y * width + 4);
    mask.fill(1, y * width + 6, y * width + 10);
  }
  const layout = stickerLayout(mask, width, height);
  assert.equal(layout.pieces.length, 2);
  assert.deepEqual(layout.area, { left: 1 / width, right: 10 / width, bottom: 2 / height, top: 6 / height });
  const radius = { x: 0.17, y: 0.17 };
  assert.equal(layout.hit({ x: 0.22, y: 0.5 }, radius, mask), layout.pieces[0]);
  assert.equal(layout.hit({ x: 0.41, y: 0.5 }, radius, mask), null);
  const remaining = mask.slice();
  for (let y = 2; y < 6; y++) remaining.fill(0, y * width + 1, y * width + 4);
  assert.equal(layout.hit({ x: 0.22, y: 0.5 }, radius, remaining), null);
  assert.equal(layout.hit({ x: 0.41, y: 0.5 }, radius, remaining), layout.pieces[1]);
});

test("pinch keeps the same world point under the midpoint as it pans and zooms", () => {
  const bounds = { left: -2, right: 2, bottom: -2, top: 2, z: 0 };
  const previous = { x: 120, y: 30 };
  const next = { x: 150, y: 70 };
  const units = 0.01;
  const start = { center: { x: 0, y: 0 }, zoom: 1 };
  const view = moveManualView(start, previous, next, 2, units, bounds);
  assert.equal(view.zoom, 2);
  for (const axis of ["x", "y"]) {
    assert.ok(Math.abs(view.center[axis] + next[axis] * units / view.zoom - previous[axis] * units) < 1e-9);
  }
  const capped = moveManualView(view, previous, { x: -10_000, y: 10_000 }, 10, units, bounds);
  assert.deepEqual(capped, { center: { x: bounds.right, y: bounds.bottom }, zoom: MAX_MANUAL_ZOOM });
  assert.deepEqual(moveManualView(capped, next, next, 0.25, units, bounds), start);
});

test("an idle manual crop can center anywhere, while the peel guard fits a lifted flap", () => {
  const center = { x: -1.2, y: 0.6 };
  const crop = stepCamera(null, null, null, 2, 0, true, center);
  assert.deepEqual(crop.pose, { ...center, z: 2 });
  const fold = { left: -1, right: 2, bottom: -0.5, top: 1, z: 0.8 };
  const guard = fitFrustum([fold], Math.tan(31 * Math.PI / 360), 390, 780, 9, true);
  const moving = stepCamera(crop, guard, guard, 2, 1 / 60, true, center);
  assert.ok(moving.pose.z >= guard.distance);
  const restored = stepCamera(moving, null, null, 2, 2, true, center);
  assert.ok(Math.abs(restored.pose.x - center.x) < 1e-6);
  assert.ok(Math.abs(restored.pose.z - 2) < 1e-5);
});
