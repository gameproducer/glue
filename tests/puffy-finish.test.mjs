import test from "node:test";
import assert from "node:assert/strict";
import { puffyNormals } from "../lib/render/PuffyFinish.ts";

test("puffy coating rounds the artwork boundary and leaves the center level", () => {
  const size = 65;
  const alpha = Uint8Array.from({ length: size * size }, (_, i) => {
    const x = i % size, y = Math.floor(i / size);
    return x >= 5 && x <= 59 && y >= 5 && y <= 59 ? 255 : 0;
  });
  const normals = puffyNormals(alpha, size, size);
  const at = (x, y) => normals.subarray((y * size + x) * 4, (y * size + x) * 4 + 4);
  assert.ok(at(6, 32)[0] < 100);
  assert.ok(at(58, 32)[0] > 155);
  assert.ok(at(32, 6)[1] < 100);
  assert.ok(at(32, 58)[1] > 155);
  assert.deepEqual([...at(32, 32).subarray(0, 3)], [128, 128, 255]);
  assert.ok(at(32, 32)[3] > at(6, 32)[3]);
});

test("a cutout has its own rounded rim pointing into the hole", () => {
  const size = 65;
  const alpha = Uint8Array.from({ length: size * size }, (_, i) => {
    const x = i % size, y = Math.floor(i / size);
    return x > 3 && x < 61 && y > 3 && y < 61 && Math.hypot(x - 32, y - 32) >= 10 ? 255 : 0;
  });
  const normals = puffyNormals(alpha, size, size);
  assert.ok(normals[(32 * size + 20) * 4] > 155);
  assert.ok(normals[(32 * size + 44) * 4] < 100);
});
