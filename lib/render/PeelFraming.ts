import type { Vec2 } from "../peel/PeelSimulation";

export type PeelBounds = { left: number; right: number; bottom: number; top: number; z: number };
export type PeelRegion = { x: number; y: number; width: number; height: number };
export type ScreenBounds = { left: number; right: number; top: number; bottom: number };
export type CameraSettings = { pan: boolean; edgeClearance: number };

export const MAX_TENSION_STRETCH = 0.04;
export const DEFAULT_CAMERA_SETTINGS: CameraSettings = { pan: true, edgeClearance: 48 };
export const MIN_EDGE_CLEARANCE = 24;
export const MAX_EDGE_CLEARANCE = 80;
const CAMERA_SETTINGS_KEY = "peel.camera";

export function readCameraSettings(): CameraSettings {
  const settings = { ...DEFAULT_CAMERA_SETTINGS };
  try {
    const saved = JSON.parse(localStorage.getItem(CAMERA_SETTINGS_KEY) ?? "{}");
    if (typeof saved?.pan === "boolean") settings.pan = saved.pan;
    if (Number.isFinite(saved?.edgeClearance)) {
      settings.edgeClearance = clamp(saved.edgeClearance, MIN_EDGE_CLEARANCE, MAX_EDGE_CLEARANCE);
    }
  } catch { /* Camera settings can also run without storage. */ }
  return settings;
}

export function saveCameraSettings(settings: CameraSettings) {
  try { localStorage.setItem(CAMERA_SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Storage is optional. */ }
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function regionBounds({ x, y, width, height }: PeelRegion, z: number): PeelBounds {
  return { left: x - width / 2, right: x + width / 2, bottom: y - height / 2, top: y + height / 2, z };
}

export function translateBounds(bounds: PeelBounds, offset: Vec2): PeelBounds {
  return {
    left: bounds.left + offset.x, right: bounds.right + offset.x,
    bottom: bounds.bottom + offset.y, top: bounds.top + offset.y, z: bounds.z,
  };
}

export function unionBounds(a: PeelBounds, b: PeelBounds): PeelBounds {
  return {
    left: Math.min(a.left, b.left), right: Math.max(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom), top: Math.max(a.top, b.top), z: Math.max(a.z, b.z),
  };
}

// The curl only travels along the pull direction. Bound its forward shift
// and keep the stationary side of the rectangle available for panning.
export function curlBounds(
  region: PeelRegion, grab: Vec2, direction: Vec2, depth: number, radius: number, cone: boolean, stretch: number,
): PeelBounds {
  const bounds = regionBounds(region, 0.022);
  const along = (Math.abs(direction.x) * region.width + Math.abs(direction.y) * region.height) / 2;
  const maxDepth = Math.max(0, depth + (grab.x - region.x) * direction.x + (grab.y - region.y) * direction.y + along);
  const minRadius = cone ? Math.max(0.12, radius * 0.58) : radius;
  const maxRadius = cone ? radius * 1.46 : radius;
  const length = maxDepth * (1 + stretch);
  const angle = Math.min(length / minRadius, Math.PI);
  const forward = Math.max(0, maxDepth + Math.max(0, length - Math.PI * minRadius) - minRadius * Math.sin(angle));
  const farthestAlong = Math.max(along, maxDepth - along + Math.max(0, length - Math.PI * minRadius));
  const across = (Math.abs(direction.y) * region.width + Math.abs(direction.x) * region.height) / 2;
  // The arc can initially extend slightly backward under tension.
  const backward = maxDepth * stretch;
  const span = (scale: number) => {
    const a = -backward * scale;
    const b = forward * scale;
    return [Math.min(a, b), Math.max(a, b)];
  };
  const [left, right] = span(direction.x);
  const [bottom, top] = span(direction.y);
  return {
    left: Math.max(bounds.left + left, region.x + (direction.x >= 0 ? -along - backward : farthestAlong)
      * direction.x - across * Math.abs(direction.y)),
    right: Math.min(bounds.right + right, region.x + (direction.x >= 0 ? farthestAlong : -along - backward)
      * direction.x + across * Math.abs(direction.y)),
    bottom: Math.max(bounds.bottom + bottom, region.y + (direction.y >= 0 ? -along - backward : farthestAlong)
      * direction.y - across * Math.abs(direction.x)),
    top: Math.min(bounds.top + top, region.y + (direction.y >= 0 ? farthestAlong : -along - backward)
      * direction.y + across * Math.abs(direction.x)),
    z: bounds.z + Math.min(2 * maxRadius, length * length / (2 * minRadius)),
  };
}

type FrustumFit = {
  xScale: number; yScale: number;
  left: number; right: number; bottom: number; top: number;
  distance: number;
};

export function fitFrustum(
  bounds: readonly PeelBounds[], tangent: number, width: number, height: number, inset: number, pan: boolean,
): FrustumFit {
  const xScale = tangent * Math.max(width * 0.25, width - 2 * inset) / height;
  const yScale = tangent * Math.max(height * 0.25, height - 2 * inset) / height;
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
  for (const sheet of bounds) {
    left = Math.min(left, sheet.left - xScale * sheet.z);
    right = Math.max(right, sheet.right + xScale * sheet.z);
    bottom = Math.min(bottom, sheet.bottom - yScale * sheet.z);
    top = Math.max(top, sheet.top + yScale * sheet.z);
  }
  const distance = pan
    ? Math.max((right - left) / (2 * xScale), (top - bottom) / (2 * yScale))
    : Math.max(-left / xScale, right / xScale, -bottom / yScale, top / yScale);
  return { xScale, yScale, left, right, bottom, top, distance };
}

type CameraPose = Vec2 & { z: number };
export type CameraMotion = { pose: CameraPose; velocity: CameraPose };

function fitCenter(fit: FrustumFit, z: number, offset: Vec2): Vec2 {
  return {
    x: clamp(offset.x, fit.right - z * fit.xScale, fit.left + z * fit.xScale),
    y: clamp(offset.y, fit.top - z * fit.yScale, fit.bottom + z * fit.yScale),
  };
}

// Integrate a critically damped spring in real time. A changing target keeps
// the current velocity, so redirecting the peel does not restart the easing.
function advance(value: number, velocity: number, target: number, seconds: number, rate: number) {
  const offset = value - target;
  const slope = velocity + rate * offset;
  const fade = Math.exp(-rate * seconds);
  return {
    value: target + (offset + slope * seconds) * fade,
    velocity: (velocity - rate * slope * seconds) * fade,
  };
}

export function stepCamera(
  current: CameraMotion | null, fit: FrustumFit, guard: FrustumFit, base: number, seconds: number, pan: boolean,
): CameraMotion {
  const targetZ = Math.max(base, fit.distance);
  const origin = { x: 0, y: 0 };
  const target = pan ? fitCenter(fit, targetZ, origin) : origin;
  if (!current) return { pose: { ...target, z: targetZ }, velocity: { ...origin, z: 0 } };
  const { pose, velocity } = current;
  const x = advance(pose.x, velocity.x, target.x, seconds, 14);
  const y = advance(pose.y, velocity.y, target.y, seconds, 14);
  const z = advance(pose.z, velocity.z, targetZ, seconds, targetZ > pose.z ? 15 : 9);
  // The larger target inset gives the spring room to move. The tighter guard
  // only intervenes when the current framing would already lose the sheet.
  const distance = Math.max(z.value, guard.distance);
  const center = fitCenter(guard, distance, { x: x.value, y: y.value });
  return {
    pose: { ...center, z: distance },
    velocity: {
      x: center.x === x.value ? x.velocity : 0,
      y: center.y === y.value ? y.velocity : 0,
      z: distance === z.value ? z.velocity : Math.max(0, z.velocity),
    },
  };
}

export function dragScaleForReach(
  point: Vec2, direction: Vec2, bounds: ScreenBounds, worldReach: number,
  base: number, travel: number, edgeClearance: number,
) {
  const inset = Math.min(edgeClearance, Math.min(bounds.right - bounds.left, bounds.bottom - bounds.top) * 0.19);
  // Aim slightly inside the margin to account for the initial ease-in and
  // leave enough travel for the solver to propagate the final adhesive front.
  const reserve = inset + Math.min(20, inset * 0.42);
  const horizontal = direction.x === 0 ? Infinity
    : ((direction.x > 0 ? bounds.right - reserve : bounds.left + reserve) - point.x) / direction.x;
  const vertical = direction.y === 0 ? Infinity
    : ((direction.y > 0 ? bounds.bottom - reserve : bounds.top + reserve) - point.y) / direction.y;
  const pixels = Math.max(8, Math.min(horizontal, vertical));
  const onset = clamp(travel / 28, 0, 1);
  const blend = onset * onset * (3 - 2 * onset);
  return base + Math.max(0, worldReach / pixels - base) * blend;
}
