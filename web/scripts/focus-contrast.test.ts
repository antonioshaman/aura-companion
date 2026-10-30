/** jsdom cannot compute CSS contrast. Check the focus token against the light
 * surfaces, including the selected Runs row where the old orange was 2.48:1.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/index.css"), "utf8");
function luminance(hex: string): number {
  const rgb = hex.match(/[a-f\d]{2}/gi)!.map((n) => parseInt(n, 16) / 255).map((n) => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
it("light focus clears 3:1 on cards, page, code and selected-row surfaces", () => {
  const focus = css.match(/--color-cc-focus:\s*(#[a-f\d]{6})/i)![1];
  for (const surface of ["ffffff", "faf9f6", "f5f4ef", "e6e5e1"]) {
    const [light, dark] = [luminance(focus.slice(1)), luminance(surface)].sort((a, b) => b - a);
    expect((light + .05) / (dark + .05)).toBeGreaterThanOrEqual(3);
  }
  expect(css).toContain("outline: 2px solid var(--color-cc-focus)");
});
