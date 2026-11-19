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
export function writeCurlDistances(state: Uint8Array, distances: Uint8Array, width: number, queue: Int32Array) {
  const size = distances.length;
  distances.fill(255);
  let tail = 0;
  const flat = (index: number) => state[index * 4] !== 0 || state[index * 4 + 1] !== 0;
  for (let i = 0; i < size; i++) {
    if (!state[i * 4 + 2]) {
      if (flat(i)) distances[i] = 0;
      continue;
    }
    const x = i % width;
    if ((x > 0 && flat(i - 1)) || (x + 1 < width && flat(i + 1))
      || (i >= width && flat(i - width)) || (i + width < size && flat(i + width))) {
      distances[i] = 1;
      queue[tail++] = i;
    }
  }
  const visit = (index: number, distance: number) => {
    if (distances[index] !== 255 || !state[index * 4 + 2]) return;
    distances[index] = distance;
    queue[tail++] = index;
  };
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    const distance = distances[i] + 1;
    if (distance === 255) break;
    const x = i % width;
    if (x > 0) visit(i - 1, distance);
    if (x + 1 < width) visit(i + 1, distance);
    if (i >= width) visit(i - width, distance);
    if (i + width < size) visit(i + width, distance);
  }
}
