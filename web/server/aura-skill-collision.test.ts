// Aura skill-collision guard (Willison W3).
//
// .agents/skills/<slug>/SKILL.md files declare a `name:` in their YAML
// frontmatter. Two skills with the same name is a bug — when both register,
// the trigger goes to the wrong one and silent capability loss follows.
//
// This test enumerates all SKILL.md files, parses the frontmatter `name`,
// and asserts uniqueness. After an upstream merge that ships new skills,
// a name collision will trip this immediately.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const SKILLS_DIR = resolve(__dirname, "..", "..", ".agents", "skills");

function listSkillDirs(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR).filter((entry) => {
    const path = resolve(SKILLS_DIR, entry);
    return statSync(path).isDirectory();
  });
}

interface SkillInfo {
  slug: string;
  name: string | null;
  origin: string | null;
  hasSkillMd: boolean;
}

function parseSkill(slug: string): SkillInfo {
  const skillPath = resolve(SKILLS_DIR, slug, "SKILL.md");
  if (!existsSync(skillPath)) {
    return { slug, name: null, origin: null, hasSkillMd: false };
  }
  const content = readFileSync(skillPath, "utf-8");
  // Lightweight frontmatter parser — we only need `name` and `origin`,
  // both expected as top-level scalar fields. Avoids pulling in a YAML dep
  // for this small surface.
  const fm = extractFrontmatter(content);
  return {
    slug,
    name: scalarField(fm, "name"),
    origin: scalarField(fm, "origin"),
    hasSkillMd: true,
  };
}

function extractFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return "";
  const end = content.indexOf("\n---", 4);
  if (end === -1) return "";
  return content.slice(4, end);
}

function scalarField(frontmatter: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m");
  const m = frontmatter.match(re);
  return m ? m[1].trim() : null;
}

describe("aura skill collisions", () => {
  it("every SKILL.md declares a `name`", () => {
    // Without `name`, the skill loader has nothing to register — the
    // skill is effectively dead. Loud failure here means a SKILL.md is
    // malformed or new convention is needed.
    const skills = listSkillDirs().map(parseSkill);
    for (const skill of skills) {
      if (!skill.hasSkillMd) continue;
      expect(skill.name, `${skill.slug}/SKILL.md is missing \`name:\``).toBeTruthy();
    }
  });

  it("no two skills declare the same `name`", () => {
    // The collision test. After an upstream merge, this catches "upstream
    // shipped a `learn` skill that conflicts with Aura's `/learn`".
    const skills = listSkillDirs().map(parseSkill).filter((s) => s.name);
    const seen = new Map<string, string[]>();
    for (const skill of skills) {
      const slugs = seen.get(skill.name!) ?? [];
      slugs.push(skill.slug);
      seen.set(skill.name!, slugs);
    }
    const collisions: string[] = [];
    for (const [name, slugs] of seen) {
      if (slugs.length > 1) {
        collisions.push(`name="${name}" declared by: ${slugs.join(", ")}`);
      }
    }
    expect(
      collisions,
      "skill name collisions detected — rename or remove one:\n" + collisions.join("\n"),
    ).toEqual([]);
  });

  it("Aura skills carry an `origin: aura` frontmatter tag (Willison W6)", () => {
    // Every SKILL.md should declare its origin so a future merge that
    // imports upstream skills can be diff'd cleanly. Aura's existing
    // skills must all be tagged `origin: aura`. Upstream-imported skills
    // (after merge) will be tagged `origin: upstream` or
    // `origin: aura-fork-of-upstream` — whichever applies.
    const skills = listSkillDirs().map(parseSkill).filter((s) => s.hasSkillMd);
    const missingOrigin = skills.filter((s) => !s.origin).map((s) => s.slug);
    expect(
      missingOrigin,
      `These skills lack an \`origin:\` frontmatter field:\n  ${missingOrigin.join("\n  ")}\n` +
        `Add \`origin: aura\` (or \`upstream\` / \`aura-fork-of-upstream\`) below the \`name:\` line.`,
    ).toEqual([]);
  });
});
