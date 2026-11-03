import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// AC13/14: inspect the shipped RU/EN pages as a visitor sees them. This guards
// the capability's product promise, not a particular tag layout or CSS class.
for (const language of ["ru", "en"] as const) {
  describe(`portable history announcement (${language})`, () => {
    it("offers archive ownership and reviewed context transfer with explicit limits", () => {
      const path = language === "ru" ? "index.html" : "en/index.html";
      const document = new JSDOM(readFileSync(resolve(__dirname, "../../landing-legacy/site", path), "utf8")).window.document;
      const announcement = document.getElementById("portable-history");
      expect(announcement).not.toBeNull();
      const text = announcement!.textContent!;
      expect(text).toContain("Claude"); expect(text).toContain("Codex"); expect(text).toContain("Obsidian");
      expect(text).toMatch(language === "ru" ? /доступную историю/i : /available history/i);
      expect(text).toMatch(language === "ru" ? /черновик/i : /draft/i);
      expect(text).toMatch(language === "ru" ? /локальн.*следующ/i : /local agents.*future/i);
      expect(text).not.toMatch(/защита от любых блокировок|immune to all blocks/i);
      // The release announces availability; local agents remain explicitly deferred.
      expect(text).toMatch(language === "ru" ? /доступно в Aura/i : /available in Aura/i);
      expect(text).not.toMatch(/готовится к выпуску|coming in a future release/i);
      expect(announcement!.querySelector('a[href*="portable-project-history"]')).toBeNull();
    });
  });
}
