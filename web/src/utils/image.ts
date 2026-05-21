export interface ImageAttachment {
  name: string;
  base64: string;
  mediaType: string;
}

// Anthropic API rejects multi-image requests where any image exceeds 2000px on
// its longest side. Modern phones shoot 3000–4000px, so every unedited photo
// in a 2+image upload trips the limit. Pre-shrink in the browser so the chat
// just works.
const MAX_IMAGE_DIMENSION = 1900;
const DOWNSCALE_JPEG_QUALITY = 0.9;

export async function downscaleImageIfNeeded(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  // GIF would collapse to a single frame, SVG is vector — leave both alone.
  if (file.type === "image/gif" || file.type === "image/svg+xml") return file;
  // jsdom / older browsers without OffscreenCanvas: skip silently, fall back
  // to the original file. The upload will still hit the API limit, but no
  // worse than before this helper existed.
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    return file;
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= MAX_IMAGE_DIMENSION) return file;

    const scale = MAX_IMAGE_DIMENSION / longest;
    const targetW = Math.round(bitmap.width * scale);
    const targetH = Math.round(bitmap.height * scale);

    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);

    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: DOWNSCALE_JPEG_QUALITY,
    });
    const newName = file.name.replace(/\.[^.]+$/i, "") + ".jpg";
    return new File([blob], newName, { type: "image/jpeg", lastModified: Date.now() });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}

export async function readFileAsBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  const processed = await downscaleImageIfNeeded(file);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({ base64, mediaType: processed.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(processed);
  });
}
