/**
 * Observed-working models — the self-maintaining half of "verified".
 *
 * The bundled/operator registry (`model-registry.ts`) is a hand-kept list and
 * goes stale the day a new model ships; the dropdown then labels the
 * operator's daily model "Untested". This store closes that gap from runtime
 * truth: whenever a session completes a successful MAIN-thread turn on model
 * X (result `success`, assistant frame with a real, non-`<synthetic>` model),
 * `ws-bridge` records `(backend, X)` here. The models endpoint then treats a
 * model as verified if it is in the registry OR observed.
 *
 * File: `~/.companion/verified-models.json` (atomic write, debounced). It is
 * an annotation cache only — it never lists, launches, or substitutes models
 * and has no effect on the fallback chain or tier policy.
 *
 * The process-wide instance is OPT-IN: `getVerifiedModelStore()` returns
 * `null` until `index.ts` wires the real one, so unit tests that construct a
 * bridge or routes never read or write the operator's real file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicJson } from "./atomic-write.js";
import { isValidModelIdForBackend } from "./model-registry.js";
import { COMPANION_HOME } from "./paths.js";
import { log } from "./logger.js";
import type { BackendType } from "./session-types.js";

export const VERIFIED_MODELS_SCHEMA_VERSION = 1 as const;
export const VERIFIED_MODELS_FILENAME = "verified-models.json";
export const VERIFIED_MODELS_PATH = join(COMPANION_HOME, VERIFIED_MODELS_FILENAME);

/** Default write debounce — a busy session completes many turns per minute. */
const DEFAULT_DEBOUNCE_MS = 5_000;
/** Bound the file: a runaway set of ids can never grow it unboundedly. */
const MAX_ENTRIES = 256;

export interface VerifiedModelEntry {
  backend: BackendType;
  id: string;
  /** Epoch ms of the first observed successful turn. */
  firstSeen: number;
  /** Epoch ms of the most recent observed successful turn. */
  lastSeen: number;
}

interface VerifiedModelsFile {
  schema_version: typeof VERIFIED_MODELS_SCHEMA_VERSION;
  models: VerifiedModelEntry[];
}

export interface VerifiedModelStoreOptions {
  /** Absolute file path. Injectable for tests — never default it in a test. */
  path: string;
  debounceMs?: number;
  now?: () => number;
}

function key(backend: BackendType, id: string): string {
  return `${backend}\0${id}`;
}

function parseEntry(raw: unknown): VerifiedModelEntry | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.backend !== "claude" && r.backend !== "codex") return null;
  if (!isValidModelIdForBackend(r.backend, r.id)) return null;
  const firstSeen = typeof r.firstSeen === "number" && Number.isFinite(r.firstSeen) ? r.firstSeen : 0;
  const lastSeen = typeof r.lastSeen === "number" && Number.isFinite(r.lastSeen) ? r.lastSeen : firstSeen;
  return { backend: r.backend, id: r.id, firstSeen, lastSeen };
}

export class VerifiedModelStore {
  private readonly path: string;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, VerifiedModelEntry>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(opts: VerifiedModelStoreOptions) {
    this.path = opts.path;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  /** Read the file once at construction. Any failure → start empty (never throws). */
  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code !== "ENOENT") {
        log.warn("verified-models", "read-failed", { event: "verified-models.read-failed", code: code ?? "unknown" });
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn("verified-models", "parse-failed", { event: "verified-models.parse-failed" });
      return;
    }
    const file = parsed as Partial<VerifiedModelsFile> | null;
    if (!file || file.schema_version !== VERIFIED_MODELS_SCHEMA_VERSION || !Array.isArray(file.models)) {
      log.warn("verified-models", "schema-rejected", { event: "verified-models.schema-rejected" });
      return;
    }
    for (const rawEntry of file.models.slice(0, MAX_ENTRIES)) {
      const e = parseEntry(rawEntry);
      if (e) this.entries.set(key(e.backend, e.id), e);
    }
  }

  has(backend: BackendType, id: string): boolean {
    return this.entries.has(key(backend, id));
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Record one observed successful main-thread turn on `id`. Ids failing the
   * per-backend validator (`<synthetic>`, empty, wrong-backend shape) are
   * ignored — the file can never carry an id that would be unsafe in argv.
   */
  recordSuccess(backend: BackendType, id: string): void {
    if (!isValidModelIdForBackend(backend, id)) return;
    const k = key(backend, id);
    const t = this.now();
    const prev = this.entries.get(k);
    if (prev) {
      prev.lastSeen = t;
    } else {
      if (this.entries.size >= MAX_ENTRIES) return;
      this.entries.set(k, { backend, id, firstSeen: t, lastSeen: t });
      log.info("verified-models", "observed", { event: "verified-models.observed", backend, model: id });
    }
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    if (this.debounceMs <= 0) {
      // Still async-free for tests: callers use flush() to persist.
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Write pending changes now (atomic). Best-effort: failures are logged, never thrown. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    const payload: VerifiedModelsFile = {
      schema_version: VERIFIED_MODELS_SCHEMA_VERSION,
      models: [...this.entries.values()],
    };
    try {
      writeAtomicJson(this.path, payload, { space: 2 });
      this.dirty = false;
    } catch (err: unknown) {
      log.warn("verified-models", "write-failed", {
        event: "verified-models.write-failed",
        code: (err as { code?: string })?.code ?? "unknown",
      });
    }
  }
}

let current: VerifiedModelStore | null = null;

/** The process-wide store, or `null` when the server has not wired one (tests). */
export function getVerifiedModelStore(): VerifiedModelStore | null {
  return current;
}

/** Wire (or clear) the process-wide store. Called once from `index.ts`. */
export function setVerifiedModelStore(store: VerifiedModelStore | null): void {
  current = store;
}
