/**
 * Social / search meta tags on the legacy auraco.space landing
 * (P7/LANDING-META, owner decision 2026-10-01).
 *
 * The page had only a <title>, so link previews in Telegram / X / search
 * results showed a bare URL. The owner allowed ONLY adding meta tags — the
 * visible landing copy must not change. These checks pin:
 *   1. Every required tag exists exactly once: description, og:title,
 *      og:description, og:image, og:url, og:type, og:locale, twitter:card.
 *   2. Fixed values the owner specified (og:url, og:type, og:locale).
 *   3. og:image / twitter:image are absolute https URLs on auraco.space and
 *      point at a file that actually ships in landing-legacy/site/ (a preview
 *      image that 404s is the same as no image).
 *   4. The description is quoted verbatim from the visible hero paragraph, so
 *      no new marketing copy slipped in through the meta tags.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// landing-meta.test.ts → web/scripts → web → repo root.
const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");
const siteDir = join(repoRoot, "landing-legacy", "site");
const html = readFileSync(join(siteDir, "index.html"), "utf-8");
const head = html.slice(0, html.indexOf("</head>"));

/** All `content` values of <meta {attr}="{key}"> tags in <head>. */
function metaContents(attr: "name" | "property", key: string): string[] {
  const re = new RegExp(`<meta\\s+${attr}="${key.replace(/[.:]/g, "\\$&")}"\\s+content="([^"]*)"\\s*/?>`, "g");
  return [...head.matchAll(re)].map((m) => m[1]);
}

function single(attr: "name" | "property", key: string): string {
  const values = metaContents(attr, key);
  // Exactly once: a duplicate tag makes crawlers pick an arbitrary one.
  expect(values, `${attr}="${key}"`).toHaveLength(1);
  return values[0];
}

describe("landing-legacy meta tags (P7/LANDING-META)", () => {
  it("has every required search / Open Graph / Twitter tag exactly once and non-empty", () => {
    const required: Array<["name" | "property", string]> = [
      ["name", "description"],
      ["property", "og:title"],
      ["property", "og:description"],
      ["property", "og:image"],
      ["property", "og:url"],
      ["property", "og:type"],
      ["property", "og:locale"],
      ["name", "twitter:card"],
    ];
    for (const [attr, key] of required) {
      expect(single(attr, key).trim(), `${attr}="${key}"`).not.toBe("");
    }
  });

  it("uses the values the owner fixed for url, type and locale", () => {
    expect(single("property", "og:url")).toBe("https://auraco.space");
    expect(single("property", "og:type")).toBe("website");
    expect(single("property", "og:locale")).toBe("ru_RU");
    // logo.png is square (1024×1024), so the small "summary" card fits;
    // summary_large_image would crop it to 2:1.
    expect(single("name", "twitter:card")).toBe("summary");
  });

  it("points preview images at an absolute auraco.space URL of a file that ships with the site", () => {
    for (const [attr, key] of [
      ["property", "og:image"],
      ["name", "twitter:image"],
    ] as const) {
      const url = new URL(single(attr, key));
      expect(url.protocol).toBe("https:");
      expect(url.host).toBe("auraco.space");
      expect(existsSync(join(siteDir, decodeURIComponent(url.pathname)))).toBe(true);
    }
  });

  it("quotes the description from the visible hero text instead of adding new copy", () => {
    const heroSub = html.match(/<p class="hero-sub">([^<]*)<\/p>/)?.[1];
    expect(heroSub).toBeDefined();
    expect(heroSub).toContain(single("name", "description"));
    expect(heroSub).toContain(single("property", "og:description"));
    // The title tags repeat the existing <title>, not a new headline.
    const title = head.match(/<title>([^<]*)<\/title>/)?.[1];
    expect(single("property", "og:title")).toBe(title);
  });
});
