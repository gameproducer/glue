/**
 * Extend simulation labels beyond the coarse silhouette. The artwork alpha,
 * rather than the simulation grid, then defines the visible outer edge/holes.
 * Sources are fixed at load time; their current layer follows every peel update.
 */
export function nearestStateSources(state: Uint8Array, width: number, height: number) {
  if (state.length !== width * height) throw new Error("State dimensions do not match");
  const sources = new Int32Array(state.length).fill(-1);
  const queue = new Int32Array(state.length);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < state.length; index++) {
    if (state[index] !== 0) {
      sources[index] = index;
      queue[tail++] = index;
    }
  }
  const visit = (index: number, source: number) => {
    if (sources[index] !== -1) return;
    sources[index] = source;
    queue[tail++] = index;
  };
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const source = sources[index];
    if (x > 0) visit(index - 1, source);
    if (x + 1 < width) visit(index + 1, source);
    if (index >= width) visit(index - width, source);
    if (index + width < state.length) visit(index + width, source);
  }
  return sources;
}

export function extendStateTexture(texture: Uint8Array, sources: Int32Array, channels = 4) {
  if (texture.length !== sources.length * channels) throw new Error("Texture dimensions do not match");
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    if (source < 0 || source === index) continue;
    for (let channel = 0; channel < channels; channel++) {
      texture[index * channels + channel] = texture[source * channels + channel];
    }
  }
}

/** Distances inside the lifted material from the edge it shares with the flat sheet. */
export function writeCurlDistances(state: Uint8Array, distances: Uint8Array, width: number) {
  const size = distances.length;
  distances.fill(255);
  for (let i = 0; i < size; i++) {
    if (state[i * 4] || state[i * 4 + 1]) distances[i] = 0;
  }
  for (let i = 0; i < size; i++) {
    if (!state[i * 4 + 2]) continue;
    if (i % width) distances[i] = Math.min(distances[i], distances[i - 1] + 1);
    if (i >= width) distances[i] = Math.min(distances[i], distances[i - width] + 1);
  }
  for (let i = size - 1; i >= 0; i--) {
    if (!state[i * 4 + 2]) continue;
    if (i % width < width - 1) distances[i] = Math.min(distances[i], distances[i + 1] + 1);
    if (i + width < size) distances[i] = Math.min(distances[i], distances[i + width] + 1);
  }
}
