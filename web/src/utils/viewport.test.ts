// @vitest-environment jsdom
/**
 * Viewport zoom policy (WCAG 1.4.4 Resize Text). The static meta must not carry
 * maximum-scale: Android Chrome honours it and blocks pinch-zoom. iOS Safari
 * ignores it for pinch-zoom (since iOS 10) but uses it to skip the auto-zoom on
 * focusing an input under 16px, so only iOS gets it, added at run time.
 * Found by the rendered a11y scan (axe meta-viewport) on 2026-10-28.
 */
import html from "../../index.html?raw";
import { beforeEach, describe, expect, it } from "vitest";

import { applyIosInputZoomGuard, isIosDevice } from "./viewport.js";

const IPHONE = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15", platform: "iPhone", maxTouchPoints: 5 };
const IPAD_DESKTOP_UA = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", platform: "MacIntel", maxTouchPoints: 5 };
const ANDROID = { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141.0 Mobile", platform: "Linux armv8l", maxTouchPoints: 5 };
const MAC = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", platform: "MacIntel", maxTouchPoints: 0 };

function meta(): HTMLMetaElement {
  return document.querySelector('meta[name="viewport"]') as HTMLMetaElement;
}

beforeEach(() => {
  document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">';
});

describe("viewport zoom policy", () => {
  it("index.html does not block zoom", () => {
    const content = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(content).toContain("width=device-width");
    expect(content).not.toMatch(/maximum-scale|user-scalable\s*=\s*(no|0)/);
  });

  it("detects iPhone and iPadOS-with-desktop-UA, not Android or a Mac", () => {
    expect(isIosDevice(IPHONE)).toBe(true);
    expect(isIosDevice(IPAD_DESKTOP_UA)).toBe(true);
    expect(isIosDevice(ANDROID)).toBe(false);
    expect(isIosDevice(MAC)).toBe(false);
  });

  it("adds maximum-scale=1 on iOS only, once", () => {
    applyIosInputZoomGuard(document, ANDROID);
    expect(meta().content).not.toContain("maximum-scale");
    applyIosInputZoomGuard(document, IPHONE);
    applyIosInputZoomGuard(document, IPHONE);
    expect(meta().content.match(/maximum-scale=1/g)).toHaveLength(1);
  });
});
