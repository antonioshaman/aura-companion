// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { downscaleImageIfNeeded, readFileAsBase64 } from "./image.js";

describe("readFileAsBase64", () => {
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

describe("downscaleImageIfNeeded", () => {
  // The actual Canvas-based downscale path is unit-testable only in a real
  // browser (jsdom has neither OffscreenCanvas nor createImageBitmap). These
  // tests cover the early-return guards that decide WHETHER to downscale.

  it("returns non-image files unchanged", async () => {
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const result = await downscaleImageIfNeeded(file);
    expect(result).toBe(file);
  });

  it("returns GIFs unchanged (downscale would collapse animation)", async () => {
    // GIF89a header — enough for MIME check; we never reach decoding.
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
