/**
 * AuraBench ablation variants (P6/D2). Each variant is a fixed configuration
 * of provider × Aura layers; the harness runs every task under every variant.
 *
 *   A  naked Claude     — `claude -p`, clean CLAUDE_CONFIG_DIR, Aura files scrubbed
 *   B  naked Codex      — `codex exec --json --ephemeral`, Aura files scrubbed
 *   C  Claude+knowledge — Companion session, KB on, everything else off
 *   D  Claude+Observer  — C + Council Mode observer pair (claude+claude) +
 *                         the observer-loop directive (see below)
 *   E  Claude+Council   — D + `/council-*` skills + auto-proceed (full stack;
 *                         `autoProceedOnIdle` is sent on create and armed by
 *                         the server since AP-WIRE)
 *   F  Codex+Aura       — Companion Codex session, KB on
 *   G  Codex+Council    — F + `/council-*` skills (see note below)
 *
 * Layer ladder for the report: A → C → D → E (each adds exactly one layer
 * group on top of the previous one).
 *
 * Observer loop (D, E): nothing in a plain task prompt makes the orchestrator
 * emit checkpoints — only the `/council-*` skills do — so without help the
 * observer sees just the spawn checkpoint, before any code exists, and D is
 * indistinguishable from C (pilot 1). `observerLoop` makes the runner append
 * a minimal directive: POST a checkpoint after changing code, wait for the
 * observer's review, address it. It uses no council skill, so the D → E step
 * still adds exactly the skills + auto-proceed. Whether the loop actually ran
 * is recorded per cell (`layer_evidence`), never assumed.
 *
 * G caveat: Council Mode only supports a Claude orchestrator (`claude+claude`,
 * `claude+codex` — the Codex half is always the observer), so a Codex-primary
 * variant cannot get the observer. G therefore differs from F by the council
 * skills layer only (Codex reads them from the workspace `.agents/skills`).
 * The layer is soft-enforced for Codex (directive only) — see
 * `docs/architecture/layer-flags.md`.
 *
 * Firewall-clean: pure data. Never `server/`.
 */

export const VARIANT_IDS = ["A", "B", "C", "D", "E", "F", "G"] as const;
export type VariantId = (typeof VARIANT_IDS)[number];

export type Provider = "claude" | "codex";

/** Layer switches sent as the per-session `layers` override (C3). */
export interface VariantLayers {
  knowledge: "on" | "off";
  observer: "on" | "off";
  council: "on" | "off";
  autoProceed: "on" | "off";
}

export interface NakedVariant {
  id: VariantId;
  label: string;
  provider: Provider;
  mode: "naked";
}

export interface AuraVariant {
  id: VariantId;
  label: string;
  provider: Provider;
  mode: "aura";
  layers: VariantLayers;
  /** Council Mode pair; absent = solo session. */
  councilPairing?: "claude+claude";
  /** Append the checkpoint → review directive to the prompt (Council pairs). */
  observerLoop?: true;
  /** Sent as `autoProceedOnIdle` when the autoProceed layer is on. */
  autoProceedOnIdle?: { idleMs: number; maxIterations: number };
}

export type Variant = NakedVariant | AuraVariant;

const layers = (on: Partial<Record<keyof VariantLayers, true>>): VariantLayers => ({
  knowledge: on.knowledge ? "on" : "off",
  observer: on.observer ? "on" : "off",
  council: on.council ? "on" : "off",
  autoProceed: on.autoProceed ? "on" : "off",
});

export const VARIANTS: Readonly<Record<VariantId, Variant>> = Object.freeze({
  A: { id: "A", label: "naked Claude", provider: "claude", mode: "naked" },
  B: { id: "B", label: "naked Codex", provider: "codex", mode: "naked" },
  C: { id: "C", label: "Claude+knowledge", provider: "claude", mode: "aura", layers: layers({ knowledge: true }) },
  D: {
    id: "D",
    label: "Claude+Observer",
    provider: "claude",
    mode: "aura",
    layers: layers({ knowledge: true, observer: true }),
    councilPairing: "claude+claude",
    observerLoop: true,
  },
  E: {
    id: "E",
    label: "Claude+full Council",
    provider: "claude",
    mode: "aura",
    layers: layers({ knowledge: true, observer: true, council: true, autoProceed: true }),
    councilPairing: "claude+claude",
    observerLoop: true,
    autoProceedOnIdle: { idleMs: 120_000, maxIterations: 3 },
  },
  F: { id: "F", label: "Codex+Aura", provider: "codex", mode: "aura", layers: layers({ knowledge: true }) },
  G: {
    id: "G",
    label: "Codex+Council",
    provider: "codex",
    mode: "aura",
    layers: layers({ knowledge: true, council: true }),
  },
});

export function isVariantId(v: unknown): v is VariantId {
  return typeof v === "string" && (VARIANT_IDS as readonly string[]).includes(v);
}

/** Parse a `--variants A,C,E` list; unknown ids are an error (never skipped silently). */
export function parseVariantList(raw: string | undefined): { ok: true; ids: VariantId[] } | { ok: false; reason: string } {
  if (!raw) return { ok: true, ids: [...VARIANT_IDS] };
  const ids = raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const bad = ids.filter((id) => !isVariantId(id));
  if (bad.length) return { ok: false, reason: `unknown variant(s): ${bad.join(", ")}` };
  return { ok: true, ids: [...new Set(ids)] as VariantId[] };
}
