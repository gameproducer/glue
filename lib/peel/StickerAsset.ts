export type StickerAsset = {
  image: HTMLImageElement;
  mask: Uint8Array;
  width: number;
  height: number;
  aspect: number;
};

const loadImage = (source: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.decoding = "async";
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error(`Could not load sticker artwork: ${source}`));
  image.src = source;
});

/** Converts the artwork alpha into the compact, bottom-up grid used by the GPU and solver. */
export async function loadStickerAsset(source: string, gridWidth = 208): Promise<StickerAsset> {
  const image = await loadImage(source);
  const aspect = image.naturalWidth / image.naturalHeight;
  const width = gridWidth;
  const height = Math.max(2, Math.round(gridWidth / aspect));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas image processing is unavailable");
  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const imageY = height - y - 1;
    for (let x = 0; x < width; x++) {
      const alpha = pixels[(imageY * width + x) * 4 + 3];
      mask[y * width + x] = alpha >= 96 ? 1 : 0;
    }
  }

  return { image, mask, width, height, aspect };
}
