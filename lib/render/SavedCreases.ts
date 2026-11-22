import type { Vec2 } from "../peel/PeelSimulation";

export function stampCrease(
  pixels: Uint8Array, width: number, height: number, size: Vec2, seam: Vec2, direction: Vec2, strength: number,
  onPiece: (cell: number) => boolean,
) {
  const halfLength = 0.18 + strength * 0.15;
  const radius = halfLength + 0.13;
  const left = Math.max(0, Math.floor(((seam.x - radius) / size.x + 0.5) * width));
  const right = Math.min(width, Math.ceil(((seam.x + radius) / size.x + 0.5) * width));
  const bottom = Math.max(0, Math.floor(((seam.y - radius) / size.y + 0.5) * height));
  const top = Math.min(height, Math.ceil(((seam.y + radius) / size.y + 0.5) * height));
  const pixel = Math.max(size.x / width, size.y / height);
  const lineWidth = Math.max(0.025, pixel * 1.1);
  let changed = false;
  for (let row = bottom; row < top; row++) {
    const dy = ((row + 0.5) / height - 0.5) * size.y - seam.y;
    for (let col = left; col < right; col++) {
      const cell = row * width + col;
      if (!onPiece(cell)) continue;
      const dx = ((col + 0.5) / width - 0.5) * size.x - seam.x;
      const lateral = -dx * direction.y + dy * direction.x;
      const along = dx * direction.x + dy * direction.y + lateral * lateral * 0.45;
      const taper = Math.max(0, 1 - (lateral / halfLength) ** 2);
      const weight = strength * taper * 255;
      const light = Math.round(weight * Math.exp(-((along / lineWidth) ** 2)));
      const dark = Math.round(weight * Math.exp(-(((along + lineWidth * 1.7) / (lineWidth * 1.3)) ** 2)));
      const index = cell * 2;
      if (light > pixels[index]) { pixels[index] = light; changed = true; }
      if (dark > pixels[index + 1]) { pixels[index + 1] = dark; changed = true; }
    }
  }
  return changed;
}
