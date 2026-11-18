import type { Vec2 } from "../peel/PeelSimulation";

export type PeelBounds = { x: number; y: number; z: number };
export const MAX_TENSION_STRETCH = 0.04;

// Conservative bounds for the full curled sheet, including silhouettes with holes.
// The shader maps the lifted strip onto an arc (then a straight run) of the same length.
export function includeCurl(
  bounds: PeelBounds, width: number, height: number,
  grab: Vec2, direction: Vec2, depth: number, radius: number, cone: boolean, stretch: number,
) {
  if (depth <= 0) return;
  const along = (Math.abs(direction.x) * width + Math.abs(direction.y) * height) / 2;
  const across = (Math.abs(direction.y) * width + Math.abs(direction.x) * height) / 2;
  const front = grab.x * direction.x + grab.y * direction.y + depth;
  const length = (front + along) * (1 + stretch);
  if (length <= 0) return;

  const minRadius = cone ? Math.max(0.12, radius * 0.58) : radius;
  const maxRadius = cone ? radius * 1.46 : radius;
  const near = front - Math.min(length, maxRadius);
  const far = front + Math.max(0, length - Math.PI * minRadius);
  const extent = Math.max(Math.abs(near), Math.abs(far));
  // A rotated rectangle around the curl can be much wider than the actual
  // sheet at first contact. Also bound it by its maximum forward displacement.
  const unstretched = front + along;
  const shift = Math.max(unstretched * stretch, unstretched + Math.max(0, length - Math.PI * minRadius)
    - minRadius * Math.sin(Math.min(length / minRadius, Math.PI)));
  bounds.x = Math.max(bounds.x, Math.min(width / 2 + shift * Math.abs(direction.x),
    extent * Math.abs(direction.x) + across * Math.abs(direction.y)));
  bounds.y = Math.max(bounds.y, Math.min(height / 2 + shift * Math.abs(direction.y),
    extent * Math.abs(direction.y) + across * Math.abs(direction.x)));
  bounds.z = Math.max(bounds.z, 0.022 + Math.min(2 * maxRadius, length * length / (2 * minRadius)));
}

export function fitDistance(bounds: PeelBounds, tangent: number, width: number, height: number, inset: number) {
  const safeX = Math.max(0.5, 1 - 2 * inset / width);
  const safeY = Math.max(0.5, 1 - 2 * inset / height);
  return bounds.z + Math.max(bounds.x / (safeX * width / height), bounds.y / safeY) / tangent;
}
