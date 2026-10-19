// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DROPDOWN_FIT_MAX_PX,
  DROPDOWN_FIT_MIN_PX,
  availableHeightAbove,
  findScrollContainer,
} from "./dropdown-fit.js";

// jsdom reports zero-size rects and no layout; each test pins the rects it
// needs by overriding getBoundingClientRect on specific elements.
function rect(top: number): DOMRect {
  return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

describe("availableHeightAbove", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("returns null when nothing can be measured (jsdom zero rects)", () => {
    // Callers must keep their static CSS cap rather than collapse the list.
    const trigger = document.createElement("div");
    document.body.appendChild(trigger);
    expect(availableHeightAbove(trigger)).toBeNull();
  });

  it("measures from the nearest scroll container's top, not the viewport", () => {
    // Owner bug 2026-10-18: the page scroll container starts below the top
    // bar, so a viewport-relative cap overflowed it and clipped the first rows.
    const container = document.createElement("div");
    container.style.overflowY = "auto";
    const trigger = document.createElement("div");
    container.appendChild(trigger);
    document.body.appendChild(container);
    container.getBoundingClientRect = () => rect(40);
    trigger.getBoundingClientRect = () => rect(383);
    expect(findScrollContainer(trigger)).toBe(container);
    // 383 - 40 - 8px gap = 335
    expect(availableHeightAbove(trigger)).toBe(335);
  });

  it("falls back to the viewport top when no ancestor scrolls", () => {
    const trigger = document.createElement("div");
    document.body.appendChild(trigger);
    trigger.getBoundingClientRect = () => rect(300);
    expect(availableHeightAbove(trigger)).toBe(292);
  });

  it("clamps to the ModelSwitcher cap above and ~3 rows below", () => {
    const trigger = document.createElement("div");
    document.body.appendChild(trigger);
    trigger.getBoundingClientRect = () => rect(2000);
    expect(availableHeightAbove(trigger)).toBe(DROPDOWN_FIT_MAX_PX);
    trigger.getBoundingClientRect = () => rect(20);
    expect(availableHeightAbove(trigger)).toBe(DROPDOWN_FIT_MIN_PX);
  });
});
