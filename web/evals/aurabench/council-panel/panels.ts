/**
 * The three council panels COUNCIL-PANEL-BENCH compares (P6), computed
 * deterministically from the in-repo selection engine so every run of a case
 * seats exactly the same roster:
 *
 *   FULL     today's engine (`composeCouncil`: relevant cross-stack lenses
 *            guaranteed, then every candidate by rank up to 11 seats) — what
 *            `/council-review-aura` seats now;
 *   ECONOMY  B4's policy (`composeEconomyCouncil`: relevance gate + seat budget
 *            sized from the diff, fail-closed lenses never dropped);
 *   MINIMAL  one PRIMARY (the best-ranked domain specialist, i.e. a
 *            non-cross-stack advisor matching a changed domain) + one
 *            ADVERSARIAL lens (`hunt`, security — the lens the engine already
 *            treats as never-starvable).
 *
 * The live run forces the roster into the skill (see `prompt.ts`) instead of
 * letting the Chair re-run selection, so panel = the only variable.
 */

import { composeCouncil } from "../../../scripts/advisor-scorer.js";
import type { AdvisorProfile } from "../../../scripts/capability-catalog.js";
import { composeEconomyCouncil, type DiffSize } from "../../../scripts/dispatch-policy.js";
import type { Fingerprint } from "../../../scripts/fingerprint.js";

export const PANEL_IDS = ["FULL", "ECONOMY", "MINIMAL"] as const;
export type PanelId = (typeof PANEL_IDS)[number];

/** The adversarial seat of MINIMAL. */
export const ADVERSARIAL_SEAT = "hunt";

export interface Panel {
  id: PanelId;
  /** Advisor ids in rank order (score desc, id asc). */
  seats: string[];
}

export function parsePanelIds(raw: string): PanelId[] {
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("council-panel: empty panel list");
  for (const id of ids) {
    if (!(PANEL_IDS as readonly string[]).includes(id)) {
      throw new Error(`council-panel: unknown panel ${id} (expected ${PANEL_IDS.join("|")})`);
    }
  }
  return [...new Set(ids)] as PanelId[];
}

function fingerprintOf(signals: string[]): Fingerprint {
  // composeCouncil reads only `signals`; the rest of Fingerprint is detection
  // metadata the bench does not have (it fingerprints the repo once, offline).
  return { signals } as unknown as Fingerprint;
}

export function composePanels(
  changedDomains: string[],
  fingerprintSignals: string[],
  profiles: AdvisorProfile[],
  diff: DiffSize,
): Record<PanelId, Panel> {
  const full = composeCouncil(fingerprintOf(fingerprintSignals), changedDomains, profiles);
  const economy = composeEconomyCouncil(fingerprintSignals, changedDomains, profiles, diff);

  const primary = full.seated.find((c) => !c.crossStack && c.matchedDomains.length > 0)
    ?? [...full.seated, ...full.crowdedOut].find((c) => !c.crossStack && c.matchedDomains.length > 0);
  if (!primary) throw new Error("council-panel: no domain specialist matches the change — MINIMAL undefined");
  if (!profiles.some((p) => p.id === ADVERSARIAL_SEAT)) {
    throw new Error(`council-panel: adversarial seat ${ADVERSARIAL_SEAT} missing from the catalog`);
  }

  return {
    FULL: { id: "FULL", seats: full.seated.map((c) => c.advisorId) },
    ECONOMY: { id: "ECONOMY", seats: economy.seated.map((c) => c.advisorId) },
    MINIMAL: { id: "MINIMAL", seats: [primary.advisorId, ADVERSARIAL_SEAT] },
  };
}
