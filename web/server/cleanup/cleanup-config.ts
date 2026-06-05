// AURA-LOCAL
// Typed configuration boundary for the cleanup subsystem (session-map
// eviction, retention sweeps, memory-pressure WARN). PLAN task T1.
//
// Per-knob discriminated union — every consumer narrows via
// `if (!ttl.enabled) return` rather than scattered `if (n === 0)` checks
// (Fowler P5 — primitive obsession). The `0 = disabled` sentinel is
// resolved exactly once at boot inside `loadCleanupConfig`; downstream
// code never re-interprets the raw env var.
//
// Six env vars (documented in docs/deploy/vps-systemd.mdx):
//   AURA_EVICTION_GRACE_HOURS                  default 24
//   AURA_ARCHIVE_TTL_DAYS                      default 30
//   AURA_RECORDINGS_SOFT_TTL_DAYS              default 14
//   AURA_RECORDINGS_HARD_TTL_DAYS              default 60
//   AURA_LOGS_TTL_DAYS                         default  7
//   AURA_MEMORY_PRESSURE_WARN_THRESHOLD_US     default 10_000_000
//
// Each env var: integer ≥0. `0` = disabled (knob skipped). Invalid input
// (negative, non-numeric, fractional) falls back to default with a
// structured WARN — boot does not abort, so a typo'd env var doesn't
// take production down, but the operator sees the line in logs.

import { log } from "../logger.js";

export type DurationConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly ms: number };

export type ThresholdConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly us: number };

export interface CleanupConfig {
  readonly evictionGrace: DurationConfig;
  readonly archiveTtl: DurationConfig;
  readonly recordingsSoftTtl: DurationConfig;
  readonly recordingsHardTtl: DurationConfig;
  readonly logsTtl: DurationConfig;
  readonly memoryPressureWarn: ThresholdConfig;
}

interface KnobSpec {
  readonly key: keyof CleanupConfig;
  readonly envVar: string;
  readonly defaultRaw: number;
  readonly unit: "hours" | "days" | "us";
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const SPECS: readonly KnobSpec[] = [
  { key: "evictionGrace",      envVar: "AURA_EVICTION_GRACE_HOURS",            defaultRaw: 24,         unit: "hours" },
  { key: "archiveTtl",         envVar: "AURA_ARCHIVE_TTL_DAYS",                defaultRaw: 30,         unit: "days"  },
  { key: "recordingsSoftTtl",  envVar: "AURA_RECORDINGS_SOFT_TTL_DAYS",        defaultRaw: 14,         unit: "days"  },
  { key: "recordingsHardTtl",  envVar: "AURA_RECORDINGS_HARD_TTL_DAYS",        defaultRaw: 60,         unit: "days"  },
  { key: "logsTtl",            envVar: "AURA_LOGS_TTL_DAYS",                   defaultRaw:  7,         unit: "days"  },
  { key: "memoryPressureWarn", envVar: "AURA_MEMORY_PRESSURE_WARN_THRESHOLD_US", defaultRaw: 10_000_000, unit: "us"    },
];

interface ResolvedKnob {
  readonly raw: number;
  readonly source: "env" | "default";
  readonly status: "parsed" | "invalid_fallback";
  readonly rawEnvValue?: string;
}

function resolveRaw(envVar: string, defaultRaw: number, env: NodeJS.ProcessEnv): ResolvedKnob {
  const rawEnvValue = env[envVar];
  if (rawEnvValue === undefined || rawEnvValue === "") {
    return { raw: defaultRaw, source: "default", status: "parsed" };
  }
  // Strict integer: no leading whitespace, no fractional, no negative, no NaN.
  // Avoid Number(...) coercion — it lets " 1.5 " through.
  if (!/^\d+$/.test(rawEnvValue)) {
    return { raw: defaultRaw, source: "default", status: "invalid_fallback", rawEnvValue };
  }
  const parsed = parseInt(rawEnvValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { raw: defaultRaw, source: "default", status: "invalid_fallback", rawEnvValue };
  }
  return { raw: parsed, source: "env", status: "parsed", rawEnvValue };
}

function buildDurationConfig(raw: number, unit: "hours" | "days"): DurationConfig {
  if (raw === 0) return { enabled: false };
  const ms = unit === "hours" ? raw * HOUR_MS : raw * DAY_MS;
  return { enabled: true, ms };
}

function buildThresholdConfig(raw: number): ThresholdConfig {
  if (raw === 0) return { enabled: false };
  return { enabled: true, us: raw };
}

/**
 * Resolve cleanup-subsystem configuration from environment. Pure: takes
 * the env map as input, returns a fully-resolved typed config plus emits
 * one structured `cleanup.config.resolved` info line per knob naming its
 * source (env vs default). Called ONCE at boot — downstream consumers
 * receive the frozen result and never re-read process.env.
 */
export function loadCleanupConfig(env: NodeJS.ProcessEnv = process.env): CleanupConfig {
  const knobs: Partial<Record<keyof CleanupConfig, DurationConfig | ThresholdConfig>> = {};

  for (const spec of SPECS) {
    const resolved = resolveRaw(spec.envVar, spec.defaultRaw, env);
    const config: DurationConfig | ThresholdConfig =
      spec.unit === "us"
        ? buildThresholdConfig(resolved.raw)
        : buildDurationConfig(resolved.raw, spec.unit);
    knobs[spec.key] = config;

    if (resolved.status === "invalid_fallback") {
      log.warn("cleanup-config", "Invalid env var, falling back to default", {
        event: "cleanup.config.resolved",
        knob: spec.key,
        envVar: spec.envVar,
        source: "default",
        unit: spec.unit,
        rawEnvValue: resolved.rawEnvValue,
        defaultRaw: spec.defaultRaw,
        enabled: config.enabled,
        reason: "invalid_input",
      });
    } else {
      log.info("cleanup-config", "Resolved knob", {
        event: "cleanup.config.resolved",
        knob: spec.key,
        envVar: spec.envVar,
        source: resolved.source,
        unit: spec.unit,
        raw: resolved.raw,
        enabled: config.enabled,
      });
    }
  }

  return {
    evictionGrace: knobs.evictionGrace as DurationConfig,
    archiveTtl: knobs.archiveTtl as DurationConfig,
    recordingsSoftTtl: knobs.recordingsSoftTtl as DurationConfig,
    recordingsHardTtl: knobs.recordingsHardTtl as DurationConfig,
    logsTtl: knobs.logsTtl as DurationConfig,
    memoryPressureWarn: knobs.memoryPressureWarn as ThresholdConfig,
  };
}
