import test from "node:test";
import assert from "node:assert/strict";
import { approachesScreenEdge, dragScaleForReach, fitDistance, includeCurl, MAX_TENSION_STRETCH, stepCameraDistance } from "../lib/render/PeelFraming.ts";
import { attachedCurlDepth } from "../lib/render/AttachedCurl.ts";
import { PeelSimulation } from "../lib/peel/PeelSimulation.ts";

test("a curved attachment stays flat at its seam even behind the nominal fold", () => {
  const cellSize = 4.8 / 208;
  assert.equal(attachedCurlDepth(0.81, 0.5, cellSize), 0);
  assert.equal(attachedCurlDepth(0.81, 1, cellSize), 0);
  const justInside = attachedCurlDepth(0.81, 2, cellSize);
  assert.ok(justInside > 0 && justInside < 2 * cellSize);
  assert.ok(attachedCurlDepth(0.81, 5, cellSize) > justInside);
  assert.equal(attachedCurlDepth(0.53, 25, cellSize), 0.53);
});

test("camera keeps folded vertices inside a padded portrait or landscape viewport", () => {
  const tangent = Math.tan(31 * Math.PI / 360);
  const inset = 24;
  for (const [width, height] of [[390, 720], [1200, 650]]) {
    for (const [dx, dy] of [[1, 0], [0, -1], [-0.6, 0.8]]) {
      for (const cone of [false, true]) {
        const radius = cone ? 0.28 : 0.32;
        const direction = { x: dx, y: dy };
        const grab = { x: -0.9, y: 0.3 };
        const depth = 2.3;
        const bounds = { x: 2.4, y: 2, z: 0 };
        includeCurl(bounds, 4.8, 4, grab, direction, depth, radius, cone, MAX_TENSION_STRETCH);
        const distance = fitDistance(bounds, tangent, width, height, inset);
        const check = ({ x, y, z }) => {
          const scale = height / (2 * tangent * (distance - z));
          assert.ok(Math.abs(x) * scale <= width / 2 - inset + 1e-8);
          assert.ok(Math.abs(y) * scale <= height / 2 - inset + 1e-8);
        };
        for (let i = 0; i <= 24; i++) {
          for (let j = 0; j <= 20; j++) {
            const x = i / 5 - 2.4;
            const y = j / 5 - 2;
            const along = (x - grab.x) * dx + (y - grab.y) * dy;
            const across = -(x - grab.x) * dy + (y - grab.y) * dx;
            const q = Math.max(0, depth - along) * (1 + MAX_TENSION_STRETCH);
            const r = Math.max(0.12, radius * (cone ? Math.min(1.46, Math.max(0.58, 1 + across * 0.24)) : 1));
            const angle = Math.min(q / r, Math.PI);
            const folded = depth + Math.max(0, q - Math.PI * r) - r * Math.sin(angle);
            check(q > 0
              ? { x: grab.x + folded * dx - across * dy, y: grab.y + folded * dy + across * dx, z: 0.022 + r * (1 - Math.cos(angle)) }
              : { x, y, z: 0.022 });
          }
        }
      }
    }
  }
});

test("a diagonal fold just entering a corner does not enlarge the viewport abruptly", () => {
  const bounds = { x: 2.4, y: 2, z: 0 };
  const diagonal = Math.SQRT1_2;
  includeCurl(bounds, 4.8, 4, { x: -2.4, y: -2 }, { x: diagonal, y: diagonal }, 0.015, 0.32, false, 0);
  assert.ok(bounds.x - 2.4 < 0.001);
  assert.ok(bounds.y - 2 < 0.001);
  assert.ok(bounds.z < 0.023);
});

test("extra reach fades in only as the pointer nears the edge in the pull direction", () => {
  const viewport = { left: 0, right: 771, top: 0, bottom: 1160 };
  const right = { x: 1, y: 0 };
  assert.equal(dragScaleForReach({ x: 420, y: 560 }, right, viewport, 8), 0);
  assert.equal(dragScaleForReach({ x: 12, y: 560 }, right, viewport, 8), 0);
  const near = dragScaleForReach({ x: 720, y: 560 }, right, viewport, 8);
  const closer = dragScaleForReach({ x: 750, y: 560 }, right, viewport, 8);
  assert.ok(near > 0 && closer > near);
});

test("auto-zoom requires movement toward a nearby screen edge", () => {
  const bounds = { left: 0, right: 771, top: 0, bottom: 1160 };
  const right = { x: 4, y: 0 };
  const left = { x: -4, y: 0 };
  assert.equal(approachesScreenEdge({ x: 500, y: 560 }, right, right, bounds), false);
  assert.equal(approachesScreenEdge({ x: 720, y: 560 }, right, right, bounds), true);
  assert.equal(approachesScreenEdge({ x: 720, y: 560 }, left, right, bounds), false);
  assert.equal(approachesScreenEdge({ x: 720, y: 560 }, { x: 0, y: 4 }, { x: 0, y: 4 }, bounds), false);
  assert.equal(approachesScreenEdge({ x: 35, y: 1100 }, { x: -1, y: 3 }, { x: -1, y: 3 }, bounds), true);
});

test("a small lifted patch can rise without zooming the fully flat sticker", () => {
  const tangent = Math.tan(31 * Math.PI / 360);
  const rest = fitDistance({ x: 2.4, y: 2.4, z: 0.022 }, tangent, 1000, 680, 28) * 1.04;
  const fold = { x: 0, y: 0, z: 0 };
  const center = { x: -1.6, y: 0.08 };
  includeCurl(fold, 0.55, 0.6, { x: -1.85, y: 0.08 }, { x: 1, y: 0 },
    0.36, 0.32, false, 0, center);
  assert.ok(fold.z > 0.2);
  const target = Math.max(rest, fitDistance(fold, tangent, 1000, 680, 28));
  assert.equal(stepCameraDistance(rest, target, fitDistance(fold, tangent, 1000, 680, 8)), rest);
  assert.equal(stepCameraDistance(8, 10, 7), 8.24);
  assert.equal(stepCameraDistance(8, 10, 9), 9);
});

test("a long peel finishes before the portrait screen edge with adaptive drag reach", () => {
  const width = 96;
  const height = 96;
  const mask = new Uint8Array(width * height);
  for (let y = 39; y < 56; y++) mask.fill(1, y * width + 8, y * width + 88);
  const bounds = { left: 0, right: 390, top: 0, bottom: 780 };
  const run = (adaptive) => {
    const simulation = new PeelSimulation(width, height, 9, 1, mask, 1, 1);
    let x = 8 / (width - 1);
    const y = 46 / (height - 1);
    simulation.begin({ x, y }, 100);
    for (let pixel = 106; pixel <= 386; pixel += 4) {
      const reach = simulation.remainingPeelTravel();
      const scale = adaptive && reach ? dragScaleForReach({ x: pixel - 4, y: 390 }, reach.direction, bounds, reach.distance) : 0;
      x += 4 * Math.max(1 / 380, scale);
      simulation.drag({ x, y }, 100 + pixel * 4);
      if (simulation.snapshot().detached) return pixel;
    }
    return null;
  };
  assert.equal(run(false), null);
  const finish = run(true);
  assert.notEqual(finish, null);
  assert.ok(finish < bounds.right - 4);
});
