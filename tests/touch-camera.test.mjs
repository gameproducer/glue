import test from "node:test";
import assert from "node:assert/strict";
import { stickerLayout } from "../lib/peel/StickerLayout.ts";
import { fitFrustum, stepCamera } from "../lib/render/PeelFraming.ts";
import { MAX_MANUAL_ZOOM, moveManualView, tappedAreaFocus } from "../lib/render/TouchCamera.ts";
import { stampCrease } from "../lib/render/SavedCreases.ts";
import { AttachedCurl } from "../lib/render/AttachedCurl.ts";

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

test("working area follows adhered cells of the selected piece and ignores the vacated footprint", () => {
  const mask = Uint8Array.from([1, 1, 1, 1, 0, 1, 1]);
  const layout = stickerLayout(mask, mask.length, 1);
  const state = Uint8Array.from([2, 3, 1, 1, 0, 1, 1]);
  assert.deepEqual(layout.areaInState(layout.pieceAtCell(1), state, 1),
    { left: 2 / 7, right: 4 / 7, bottom: 0, top: 1 });
  assert.equal(layout.pieceAtCell(4), null);
  state[2] = state[3] = 3;
  assert.equal(layout.areaInState(layout.pieces[0], state, 1), null);
});

test("tapping a broad piece zooms modestly toward the tap and a second tap retargets at the same scale", () => {
  const bounds = { left: -2.4, right: 2.4, bottom: -1.6, top: 1.6, z: 0.02 };
  const overview = 12;
  const left = tappedAreaFocus(bounds, { x: -2, y: 1 }, overview);
  const right = tappedAreaFocus(bounds, { x: 2, y: -1 }, overview);
  assert.ok(left.x < -1 && left.y > 0.5);
  assert.ok(right.x > 1 && right.y < -0.5);
  assert.equal(right.z, left.z);
  assert.ok(Math.abs((overview - bounds.z) / (left.z - bounds.z) - 1.22) < 1e-9);
});

test("a lifted strip is framed at its transformed location instead of its old footprint", () => {
  const width = 64, height = 16;
  const sources = Int32Array.from({ length: width * height }, (_, cell) => cell);
  const curl = new AttachedCurl(width, height, 4.8, 1.2, sources);
  const seam = new Uint8Array(width * height).fill(100);
  const sheet = new Uint8Array(width * height * 4);
  for (let y = 4; y < 12; y++) {
    for (let x = 2; x < 18; x++) sheet[(y * width + x) * 4 + 2] = 255;
  }
  const direction = { x: 1, y: 0 };
  curl.update(sheet, seam, { x: -2.25, y: 0 }, direction, 2.2, 0.32, false);
  const bounds = curl.projectedBounds(direction, 0);
  assert.ok(bounds.left > -1.6);
  assert.ok(bounds.z > 0.5);
  assert.ok(bounds.bottom < -0.3 && bounds.top > 0.3);
});

test("a focus return progresses pan and zoom together in one move", () => {
  let camera = stepCamera(null, null, null, 3, 0, true, { x: 2, y: -1 }, true);
  for (let frame = 0; frame < 30; frame++) {
    camera = stepCamera(camera, null, null, 9, 1 / 60, true, { x: 0, y: 0 }, true);
    const progress = (camera.pose.z - 3) / 6;
    assert.ok(Math.abs(camera.pose.x / 2 + progress - 1) < 1e-9);
    assert.ok(Math.abs(-camera.pose.y + progress - 1) < 1e-9);
  }
});

test("saved creases are confined to their piece and survive weaker passes", () => {
  const size = 100;
  const pixels = new Uint8Array(size * size * 2);
  const stroke = strength => stampCrease(pixels, size, size, { x: 4, y: 4 }, { x: 0, y: 0 },
    { x: 1, y: 0 }, strength, cell => cell % size < size / 2);
  assert.equal(stroke(0.8), true);
  const saved = pixels.slice();
  assert.ok(saved.some((value, index) => index % 2 === 0 && value > 0));
  assert.ok(saved.some((value, index) => index % 2 === 1 && value > 0));
  assert.ok(saved.every((value, index) => Math.floor(index / 2) % size < size / 2 || value === 0));
  assert.equal(stroke(0.3), false);
  assert.deepEqual(pixels, saved);
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
