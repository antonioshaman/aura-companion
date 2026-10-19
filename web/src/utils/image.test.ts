// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downscaleImageIfNeeded, readFileAsBase64, sniffImageMediaType } from "./image.js";

const toBase64 = (bytes: number[]) =>
  btoa(String.fromCharCode(...bytes));

describe("sniffImageMediaType", () => {
  it("detects JPEG from the FF D8 FF magic number", () => {
    expect(sniffImageMediaType(toBase64([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image/jpeg");
  });

  it("detects PNG from the 89 50 4E 47 magic number", () => {
    expect(sniffImageMediaType(toBase64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image/png");
  });

  it("detects GIF and WEBP", () => {
    expect(sniffImageMediaType(toBase64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
    expect(
      sniffImageMediaType(
        toBase64([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe("image/webp");
  });

  it("returns null for unrecognised or too-short input", () => {
    expect(sniffImageMediaType(toBase64([0x00, 0x01, 0x02, 0x03]))).toBeNull();
    expect(sniffImageMediaType(toBase64([0xff]))).toBeNull();
    expect(sniffImageMediaType("not-valid-base64-@@@")).toBeNull();
  });
});

describe("readFileAsBase64", () => {
  it("corrects a mislabelled .png that is actually JPEG bytes", async () => {
    // The bug source: a screenshot saved as .png but encoded as JPEG. The
    // browser reports image/png from the extension; the bytes say JPEG. We
    // must emit image/jpeg so the Anthropic API doesn't 400 the request.
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const file = new File([jpegBytes], "screenshot.png", { type: "image/png" });

    const result = await readFileAsBase64(file);

    expect(result.mediaType).toBe("image/jpeg");
  });


  it("reads a text file and returns base64 + mediaType", async () => {
    // Create a Blob-backed File with known content
    const content = "hello world";
    const file = new File([content], "test.txt", { type: "text/plain" });

    const result = await readFileAsBase64(file);

    // The base64 of "hello world" is "aGVsbG8gd29ybGQ="
    expect(result.base64).toBe("aGVsbG8gd29ybGQ=");
    expect(result.mediaType).toBe("text/plain");
  });

  it("reads an image file and returns correct mediaType", async () => {
    // Create a minimal 1x1 PNG file (valid PNG header only). jsdom has no
    // OffscreenCanvas, so downscaleImageIfNeeded short-circuits and we get
    // the original bytes back through readFileAsBase64 unchanged.
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG header
    ]);
    const file = new File([pngBytes], "pixel.png", { type: "image/png" });

    const result = await readFileAsBase64(file);

    expect(result.mediaType).toBe("image/png");
    expect(typeof result.base64).toBe("string");
    expect(result.base64.length).toBeGreaterThan(0);
  });
});

describe("downscaleImageIfNeeded — early-return guards (no canvas needed)", () => {
  // These cases never reach the canvas pipeline, so they work in plain jsdom
  // without any global stubs.

  it("returns non-image files unchanged", async () => {
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const result = await downscaleImageIfNeeded(file);
    expect(result).toBe(file);
  });

  it("returns GIFs unchanged (downscale would collapse animation)", async () => {
    const file = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])], "anim.gif", {
      type: "image/gif",
    });
    const result = await downscaleImageIfNeeded(file);
    expect(result).toBe(file);
  });

  it("returns SVGs unchanged (vector — no raster downscale)", async () => {
    const file = new File(["<svg/>"], "icon.svg", { type: "image/svg+xml" });
    const result = await downscaleImageIfNeeded(file);
    expect(result).toBe(file);
  });

  it("falls back to original when the environment lacks OffscreenCanvas", async () => {
    // jsdom has no OffscreenCanvas — the guard returns the file as-is rather
    // than throwing. This is the production-safety path for unsupported
    // browsers; without it any upload from such a browser would error out.
    const file = new File([new Uint8Array(8)], "pixel.png", { type: "image/png" });
    const result = await downscaleImageIfNeeded(file);
    expect(result).toBe(file);
  });
});

describe("downscaleImageIfNeeded — canvas pipeline (with stubbed globals)", () => {
  // jsdom has neither OffscreenCanvas nor createImageBitmap; stub both
  // globally to exercise the actual resize codepath. Without these stubs,
  // the downscale function's body is unreachable in unit tests and CI's
  // coverage gate fails on this file.

  let mockGetContext: ReturnType<typeof vi.fn>;
  let mockConvertToBlob: ReturnType<typeof vi.fn>;
  let mockDrawImage: ReturnType<typeof vi.fn>;
  let mockClose: ReturnType<typeof vi.fn>;
  let bitmapDims: { width: number; height: number };

  beforeEach(() => {
    mockDrawImage = vi.fn();
    mockClose = vi.fn();
    mockGetContext = vi.fn(() => ({ drawImage: mockDrawImage }));
    mockConvertToBlob = vi.fn(async () => new Blob(["fake-jpeg-bytes"], { type: "image/jpeg" }));
    bitmapDims = { width: 4000, height: 3000 };

    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        width: bitmapDims.width,
        height: bitmapDims.height,
        close: mockClose,
      })),
    );
    vi.stubGlobal(
      "OffscreenCanvas",
      class MockOffscreenCanvas {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        getContext = mockGetContext;
        convertToBlob = mockConvertToBlob;
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("downscales a 4000×3000 photo to fit within 1900px on the longest side", async () => {
    const file = new File([new Uint8Array(100)], "photo.jpg", { type: "image/jpeg" });
    const result = await downscaleImageIfNeeded(file);

    // Returned file must be a new File (not identity), with image/jpeg type
    // and a .jpg extension. Width/height arguments to drawImage prove the
    // resize math (1900 / 4000 = 0.475 → 4000*0.475 = 1900, 3000*0.475 = 1425).
    expect(result).not.toBe(file);
    expect(result.type).toBe("image/jpeg");
    expect(result.name).toBe("photo.jpg");

    expect(mockDrawImage).toHaveBeenCalledTimes(1);
    const drawCall = mockDrawImage.mock.calls[0];
    expect(drawCall[3]).toBe(1900); // targetW
    expect(drawCall[4]).toBe(1425); // targetH
    expect(mockClose).toHaveBeenCalledTimes(1); // bitmap cleanup
  });

  it("renames any non-jpg extension to .jpg on downscale", async () => {
    const file = new File([new Uint8Array(100)], "screenshot.png", { type: "image/png" });
    const result = await downscaleImageIfNeeded(file);
    expect(result.name).toBe("screenshot.jpg");
  });

  it("skips downscale when longest side already ≤ 1900px", async () => {
    bitmapDims = { width: 1024, height: 768 };
    const file = new File([new Uint8Array(50)], "small.png", { type: "image/png" });
    const result = await downscaleImageIfNeeded(file);

    expect(result).toBe(file); // identity — no resize work
    expect(mockDrawImage).not.toHaveBeenCalled();
    expect(mockConvertToBlob).not.toHaveBeenCalled();
  });

  it("falls back to original when createImageBitmap throws (corrupt file)", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("decode failed");
      }),
    );
    const file = new File([new Uint8Array(8)], "corrupt.png", { type: "image/png" });
    const result = await downscaleImageIfNeeded(file);
    expect(result).toBe(file);
  });

  it("falls back to original when canvas getContext returns null", async () => {
    mockGetContext.mockReturnValueOnce(null);
    const file = new File([new Uint8Array(50)], "photo.jpg", { type: "image/jpeg" });
    const result = await downscaleImageIfNeeded(file);
    // Bitmap was created and we know it was >1900 (default 4000×3000), but
    // without a 2d context we can't draw — fall back rather than error.
    expect(result).toBe(file);
    expect(mockClose).toHaveBeenCalledTimes(1); // bitmap still cleaned up via finally
  });

  it("falls back to original when convertToBlob rejects mid-resize", async () => {
    mockConvertToBlob.mockRejectedValueOnce(new Error("encode failed"));
    const file = new File([new Uint8Array(50)], "photo.jpg", { type: "image/jpeg" });
    const result = await downscaleImageIfNeeded(file);
    expect(result).toBe(file);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("readFileAsBase64 returns image/jpeg media type when downscale fires", async () => {
    // End-to-end: a >1900px PNG goes through readFileAsBase64 and the
    // mediaType reflects the post-downscale JPEG, not the original PNG.
    const file = new File([new Uint8Array(100)], "photo.png", { type: "image/png" });
    const result = await readFileAsBase64(file);
    expect(result.mediaType).toBe("image/jpeg");
  });
});
