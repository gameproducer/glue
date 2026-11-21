import type { Vec2 } from "./PeelSimulation";

export type StickerArea = { left: number; right: number; bottom: number; top: number };
export type StickerPiece = { sample: number; area: StickerArea };

export function stickerLayout(mask: Uint8Array, width: number, height: number) {
  const labels = new Uint32Array(mask.length);
  const queue = new Int32Array(mask.length);
  const pieces: StickerPiece[] = [];
  const area: StickerArea = { left: 1, right: 0, bottom: 1, top: 0 };
  for (let sample = 0; sample < mask.length; sample++) {
    if (!mask[sample] || labels[sample]) continue;
    const label = pieces.length + 1;
    let count = 0;
    const visit = (cell: number) => {
      if (!mask[cell] || labels[cell]) return;
      labels[cell] = label;
      queue[count++] = cell;
    };
    visit(sample);
    let left = width;
    let right = 0;
    let bottom = height;
    let top = 0;
    for (let i = 0; i < count; i++) {
      const cell = queue[i];
      const x = cell % width;
      const y = Math.floor(cell / width);
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      bottom = Math.min(bottom, y);
      top = Math.max(top, y + 1);
      if (x > 0) visit(cell - 1);
      if (x < width - 1) visit(cell + 1);
      if (y > 0) visit(cell - width);
      if (y < height - 1) visit(cell + width);
    }
    const bounds = { left: left / width, right: right / width, bottom: bottom / height, top: top / height };
    pieces.push({ sample, area: bounds });
    area.left = Math.min(area.left, bounds.left);
    area.right = Math.max(area.right, bounds.right);
    area.bottom = Math.min(area.bottom, bounds.bottom);
    area.top = Math.max(area.top, bounds.top);
  }

  function hit(point: Vec2, radius: Vec2, remaining: Uint8Array) {
    const x = Math.floor(point.x * width);
    const y = Math.floor(point.y * height);
    const labelAt = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return 0;
      const cell = y * width + x;
      return remaining[cell] ? labels[cell] : 0;
    };
    const direct = labelAt(x, y);
    if (direct) return pieces[direct - 1];
    if (radius.x <= 0 || radius.y <= 0) return null;
    let nearby = 0;
    for (let row = Math.max(0, Math.floor((point.y - radius.y) * height)); row < height && row < (point.y + radius.y) * height; row++) {
      for (let col = Math.max(0, Math.floor((point.x - radius.x) * width)); col < width && col < (point.x + radius.x) * width; col++) {
        const label = labelAt(col, row);
        if (!label || ((col + 0.5 - point.x * width) / (radius.x * width)) ** 2
            + ((row + 0.5 - point.y * height) / (radius.y * height)) ** 2 > 1) continue;
        if (nearby && nearby !== label) return null;
        nearby = label;
      }
    }
    return nearby ? pieces[nearby - 1] : null;
  }

  return { area: pieces.length ? area : { left: 0, right: 1, bottom: 0, top: 1 }, pieces, hit };
}
