/** Downscale + convert garment images so Decart signaling stays stable. */
const MAX_EDGE = 1024;
const JPEG_QUALITY = 0.85;

export async function prepareGarmentBlob(input: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(input);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return input;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", JPEG_QUALITY)
    );
    return blob ?? input;
  } finally {
    bitmap.close();
  }
}
