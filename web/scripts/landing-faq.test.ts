import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

for (const page of ["index.html", "en/index.html"]) {
  describe(`live landing FAQ: ${page}`, () => {
    it("connects native buttons to answers and excludes collapsed content from focus/accessibility", () => {
      // Exercise the actual shipped handler rather than a copied implementation.
      const html = readFileSync(resolve(__dirname, "../../landing-legacy/site", page), "utf8");
      const { document } = new JSDOM().window;
      document.body.innerHTML = html.slice(html.indexOf('<section id="faq">'), html.indexOf('</section>', html.indexOf('<section id="faq">')) + 10);
      const handler = html.match(/function toggleFaq\(el\) \{[\s\S]*?\n  \}/)![0];
      const toggle = new Function("document", `${handler}; return toggleFaq;`)(document);
      const buttons = document.querySelectorAll<HTMLButtonElement>(".faq-q");
      expect(buttons.length).toBeGreaterThanOrEqual(7);
      for (const button of buttons) {
        expect(button.tagName).toBe("BUTTON");
        expect(button.type).toBe("button");
        const answer = document.getElementById(button.getAttribute("aria-controls")!)!;
        expect(answer.hasAttribute("inert")).toBe(true);
        expect(answer.getAttribute("aria-hidden")).toBe("true");
        toggle(button);
        expect(button.getAttribute("aria-expanded")).toBe("true");
        expect(answer.inert).toBe(false);
        expect(answer.getAttribute("aria-hidden")).toBe("false");
        toggle(button);
        expect(button.getAttribute("aria-expanded")).toBe("false");
        expect(answer.inert).toBe(true);
        expect(answer.getAttribute("aria-hidden")).toBe("true");
      }
      // The live pages must not regress to the archive's blocking notifications.
      expect(html).not.toMatch(/\balert\s*\(/);
    });
  });
}
