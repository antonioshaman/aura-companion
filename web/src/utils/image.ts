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

// The browser-reported `File.type` is derived from the file extension / OS
// clipboard metadata, NOT the actual bytes. Screenshots saved as `.png` but
// encoded as JPEG (common from messengers) arrive labelled `image/png`, and
// the Anthropic API rejects the whole request with a 400 when the declared
// media type disagrees with the real bytes. Sniff the magic number so the
// label always matches the payload.
export function sniffImageMediaType(base64: string): string | null {
  let bytes: Uint8Array;
  try {
    const binary = atob(base64.slice(0, 24));
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length < 4) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38)
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

export async function readFileAsBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  const processed = await downscaleImageIfNeeded(file);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      const sniffed = processed.type.startsWith("image/") ? sniffImageMediaType(base64) : null;
      resolve({ base64, mediaType: sniffed ?? processed.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(processed);
  });
}
