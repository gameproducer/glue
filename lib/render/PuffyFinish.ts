/** A rounded coating normal map from bottom-up artwork alpha, independent of peel state. */
export function puffyNormals(alpha: Uint8Array, width: number, height: number) {
  if (alpha.length !== width * height) throw new Error("Artwork dimensions do not match");
  // Exact squared Euclidean distance, using the lower envelope of parabolas
  // along each row and column. Padding also rounds artwork touching the image edge.
  const paddedWidth = width + 2;
  const paddedHeight = height + 2;
  const distance = new Float64Array(paddedWidth * paddedHeight);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      distance[(y + 1) * paddedWidth + x + 1] = alpha[y * width + x] < 96 ? 0 : 1e12;
    }
  }
  const line = new Float64Array(Math.max(paddedWidth, paddedHeight));
  const sites = new Int32Array(line.length);
  const breaks = new Float64Array(line.length + 1);
  const transform = (start: number, stride: number, size: number) => {
    for (let q = 0; q < size; q++) line[q] = distance[start + q * stride];
    let k = 0;
    sites[0] = 0;
    breaks[0] = -Infinity;
    breaks[1] = Infinity;
    for (let q = 1; q < size; q++) {
      let intersection;
      do {
        const p = sites[k];
        intersection = (line[q] + q * q - line[p] - p * p) / (2 * (q - p));
        if (intersection > breaks[k]) break;
        k--;
      } while (k >= 0);
      sites[++k] = q;
      breaks[k] = intersection;
      breaks[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < size; q++) {
      while (breaks[k + 1] < q) k++;
      distance[start + q * stride] = (q - sites[k]) ** 2 + line[sites[k]];
    }
  };
  for (let y = 0; y < paddedHeight; y++) transform(y * paddedWidth, 1, paddedWidth);
  for (let x = 0; x < paddedWidth; x++) transform(x, paddedWidth, paddedHeight);
  const radius = Math.max(2, Math.min(width, height) * 0.11);
  let dome = Float32Array.from(alpha, (_, i) => {
    const d = Math.sqrt(distance[(Math.floor(i / width) + 1) * paddedWidth + i % width + 1]);
    const edge = 1 - Math.min(1, d / radius);
    return radius * 0.75 * Math.sqrt(1 - edge * edge);
  });
  // Round the medial ridges and raster corners before taking the gradient.
  for (let pass = 0; pass < 24; pass++) {
    const smooth = new Float32Array(dome.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        smooth[i] = (dome[i] * 4 + dome[y * width + Math.max(0, x - 1)]
          + dome[y * width + Math.min(width - 1, x + 1)]
          + dome[Math.max(0, y - 1) * width + x]
          + dome[Math.min(height - 1, y + 1) * width + x]) / 8;
      }
    }
    dome = smooth;
  }
  const pixels = new Uint8Array(alpha.length * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const nx = (dome[y * width + Math.max(0, x - 1)] - dome[y * width + Math.min(width - 1, x + 1)]) / 2;
      const ny = (dome[Math.max(0, y - 1) * width + x] - dome[Math.min(height - 1, y + 1) * width + x]) / 2;
      const length = Math.hypot(nx, ny, 1);
      pixels[i * 4] = Math.round((nx / length * 0.5 + 0.5) * 255);
      pixels[i * 4 + 1] = Math.round((ny / length * 0.5 + 0.5) * 255);
      pixels[i * 4 + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
      pixels[i * 4 + 3] = Math.round(Math.min(1, dome[i] / radius) * 255);
    }
  }
  return pixels;
}
