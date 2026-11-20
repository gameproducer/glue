import test from "node:test";
import assert from "node:assert/strict";
import { curlBounds, dragScaleForReach, fitFrustum, MAX_TENSION_STRETCH, regionBounds, stepCamera } from "../lib/render/PeelFraming.ts";
import { attachedCurlDepth } from "../lib/render/AttachedCurl.ts";
import { PeelSimulation } from "../lib/peel/PeelSimulation.ts";

const tangent = Math.tan(31 * Math.PI / 360);
const origin = { x: 0, y: 0 };

test("a curved attachment stays flat at its seam even behind the nominal fold", () => {
  const cellSize = 4.8 / 208;
  assert.equal(attachedCurlDepth(0.81, 0.5, cellSize), 0);
  assert.equal(attachedCurlDepth(0.81, 1, cellSize), 0);
  const justInside = attachedCurlDepth(0.81, 2, cellSize);
  assert.ok(justInside > 0 && justInside < 2 * cellSize);
  assert.ok(attachedCurlDepth(0.81, 5, cellSize) > justInside);
  assert.equal(attachedCurlDepth(0.53, 25, cellSize), 0.53);
});

test("panning keeps lifted vertices inside a padded viewport in portrait and landscape", () => {
  const inset = 24;
  const region = { x: -0.3, y: 0.4, width: 4.8, height: 4 };
  for (const [width, height] of [[390, 720], [1200, 650]]) {
    for (const [dx, dy] of [[1, 0], [0, -1], [-0.6, 0.8]]) {
      for (const cone of [false, true]) {
        const radius = cone ? 0.28 : 0.32;
        const direction = { x: dx, y: dy };
        const grab = { x: -0.9, y: 0.3 };
        const depth = 2.3;
        const flat = regionBounds(region, 0.022);
        const fold = curlBounds(region, grab, direction, depth, radius, cone, MAX_TENSION_STRETCH);
        const fit = fitFrustum([flat, fold], tangent, width, height, inset, true);
        const { pose } = stepCamera(null, fit, fit, 0, 0, true);
        const check = ({ x, y, z }) => {
          const scale = height / (2 * tangent * (pose.z - z));
          assert.ok(Math.abs(x - pose.x) * scale <= width / 2 - inset + 1e-8);
          assert.ok(Math.abs(y - pose.y) * scale <= height / 2 - inset + 1e-8);
        };
        for (let i = 0; i <= 24; i++) {
          for (let j = 0; j <= 20; j++) {
            const x = region.x + i / 5 - 2.4;
            const y = region.y + j / 5 - 2;
            const along = (x - grab.x) * dx + (y - grab.y) * dy;
            const across = -(x - grab.x) * dy + (y - grab.y) * dx;
            const r = Math.max(0.12, radius * (cone ? Math.min(1.46, Math.max(0.58, 1 + across * 0.24)) : 1));
            // The attached shader may pin part of the curl to the seam.
            for (const fraction of [0, 0.4, 1]) {
              const q = Math.max(0, depth - along) * fraction;
              const arc = q * (1 + MAX_TENSION_STRETCH);
              const angle = Math.min(arc / r, Math.PI);
              const shift = q + Math.max(0, arc - Math.PI * r) - r * Math.sin(angle);
              check({ x: x + shift * dx, y: y + shift * dy, z: 0.022 + r * (1 - Math.cos(angle)) });
            }
          }
        }
      }
    }
  }
});

test("an off-center flap can fit closer with panning than with centered zoom", () => {
  const sticker = regionBounds({ ...origin, width: 4.8, height: 3 }, 0.022);
  const flap = regionBounds({ x: 3.2, y: 0, width: 3, height: 2 }, 0.6);
  const fit = fitFrustum([sticker, flap], tangent, 390, 700, 24, true);
  const centered = fitFrustum([sticker, flap], tangent, 390, 700, 24, false);
  const { pose } = stepCamera(null, fit, fit, 0, 0, true);
  assert.ok(pose.x > 0);
  assert.equal(pose.y, 0);
  assert.ok(fit.distance < centered.distance * 0.8);
});

test("picking up one corner leaves the camera still until the fold needs space", () => {
  const sticker = regionBounds({ ...origin, width: 4.8, height: 4 }, 0.022);
  const region = { x: -1.6, y: 0.08, width: 0.55, height: 0.6 };
  const fold = curlBounds(region, { x: -1.85, y: 0.08 }, { x: 1, y: 0 }, 0.36, 0.32, false, 0);
  const rest = fitFrustum([sticker], tangent, 1000, 680, 28, true);
  const fit = fitFrustum([sticker, fold], tangent, 1000, 680, 28, true);
  const base = rest.distance * 1.04;
  const initial = stepCamera(null, rest, rest, base, 0, true);
  assert.ok(fold.z > 0.2);
  assert.deepEqual(stepCamera(initial, fit, fit, base, 1 / 60, true), initial);
});

test("zoom easing starts gently, stays frame-rate independent, and respects the guard", () => {
  const sticker = regionBounds({ ...origin, width: 4.8, height: 4 }, 0.022);
  const fit = fitFrustum([sticker], tangent, 1000, 680, 28, true);
  const base = fit.distance;
  const initial = stepCamera(null, fit, fit, base, 0, true);
  const run = (hz) => {
    let current = initial;
    for (let i = 0; i < hz / 2; i++) current = stepCamera(current, fit, fit, base * 2, 1 / hz, true);
    return current.pose.z;
  };
  const first = stepCamera(initial, fit, fit, base * 2, 1 / 60, true);
  assert.ok(first.pose.z - base < base * 0.04);
  assert.ok(Math.abs(run(30) - run(120)) < 1e-8);
  const large = fitFrustum([regionBounds({ ...origin, width: 8, height: 5 }, 0.6)], tangent, 1000, 680, 8, true);
  assert.ok(stepCamera(initial, large, large, base, 1 / 60, true).pose.z >= large.distance);
});

test("reach starts easing in early, reserves a diagonal margin, and leaves short pulls alone", () => {
  const viewport = { left: 0, right: 390, top: 0, bottom: 720 };
  const right = { x: 1, y: 0 };
  const diagonal = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
  const base = 1 / 320;
  const start = { x: 120, y: 470 };
  const gain = (direction, reach, travel) => dragScaleForReach(start, direction, viewport, reach, base, travel, 48);
  assert.equal(gain(right, 1.4, 0), base);
  assert.equal(gain(right, 0.3, 40), base);
  assert.ok(gain(right, 1.4, 14) > base && gain(right, 1.4, 14) < gain(right, 1.4, 28));
  assert.ok(gain(diagonal, 1.4, 28) > base);
});

test("full sweeps detach before the configured margin in portrait and landscape", () => {
  const size = 96;
  const mask = new Uint8Array(size * size);
  for (let y = 39; y < 56; y++) mask.fill(1, y * size + 8, y * size + 88);
  for (const [width, height] of [[390, 780], [900, 360]]) {
    for (const clearance of [24, 48, 64]) {
      for (const sign of [1, -1]) {
        const bounds = { left: 0, right: width, top: 0, bottom: height };
        const start = sign > 0 ? width * 0.24 : width * 0.76;
        const limit = sign > 0 ? width - clearance : clearance;
        const unitsPerPixel = 1 / (Math.min(width, height) * 0.9);
        const simulation = new PeelSimulation(size, size, 9, 1, mask, 1, 1);
        let x = (sign > 0 ? 8 : 87) / (size - 1);
        const y = 46 / (size - 1);
        simulation.begin({ x, y }, 100);
        let finish = null;
        for (let travel = 3; (limit - start) * sign >= travel; travel += 3) {
          const pixel = start + travel * sign;
          const reach = simulation.remainingPeelTravel();
          const scale = reach ? dragScaleForReach({ x: pixel - 3 * sign, y: height / 2 }, reach.direction,
            bounds, reach.distance, unitsPerPixel, travel - 3, clearance) : unitsPerPixel;
          x += 3 * scale * sign;
          simulation.drag({ x, y }, 100 + travel * 4);
          if (simulation.snapshot().detached) {
            finish = pixel;
            break;
          }
        }
        assert.notEqual(finish, null, `Could not finish at ${width}×${height}, direction ${sign}, clearance ${clearance}`);
        assert.ok(Math.min(finish, width - finish) >= clearance);
      }
    }
  }
});
