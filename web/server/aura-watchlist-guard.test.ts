// Aura watchlist guard tests (Beck B2 / Fowler F5).
//
// For each file listed in aura/CONFLICT_WATCHLIST.md, assert that key
// "sentinel" markers Aura introduced are still present. If an upstream
// merge silently removes one of them, this test fails loudly and points
// the maintainer at the watchlist entry — instead of the regression
// surfacing weeks later in production.
//
// We use sentinel-presence rather than full hash/snapshot because:
//   - Aura code in these files is expected to evolve (e.g. when an
//     upstream merge re-applies our heartbeat into a different shape).
//   - Hash snapshots produce noisy approve-flow churn that maintainers
//     start ignoring — defeating the guard.
//   - Sentinel-presence is loud on actual regressions (sentinel gone)
//     and silent on benign refactors (sentinel still there).
//
// If you intentionally rename a sentinel, update the SENTINELS map below
// AND the matching entry in aura/CONFLICT_WATCHLIST.md.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");

interface Sentinel {
  /** Path relative to repo root */
  file: string;
  /** Substrings that MUST appear in the file */
  must: string[];
  /** One-sentence reminder for failure messages */
  reason: string;
}

const SENTINELS: Sentinel[] = [
  {
    file: "web/server/update-checker.ts",
    must: [
      "aura-keep-upstream-name",
      "version-stopper",
      "the-companion",
    ],
    reason:
      "version-stopper note + keep-upstream marker + npm package name to query",
  },
  {
    file: "web/server/ws-bridge.ts",
    must: [
      "startBrowserHeartbeat",
      "stopBrowserHeartbeat",
      "broadcastBrowserHeartbeat",
      "BROWSER_HEARTBEAT_INTERVAL_MS",
      "AURA-LOCAL",
    ],
    reason:
      "browser heartbeat (today's fix) — preserves WS over mobile/proxy idle drops",
  },
  {
    file: "web/server/session-state-machine.ts",
    must: ["AURA_EXTRA_READY_TRANSITIONS", "awaiting_permission"],
    reason:
      "ready→awaiting_permission edge so permission_request after `result` is not silently blocked",
  },
  {
    file: "web/src/components/Sidebar.tsx",
    must: ["auraIsActiveSession"],
    reason:
      "orphan/archived/cron/agent filter for the active sidebar list (commit 93a205c)",
  },
  {
    file: "web/package.json",
    must: ['"name": "aura-companion"', '"branding"'],
    reason:
      "Aura identity and branding script wiring",
  },
  {
    file: "branding.config.json",
    must: [
      '"keepUpstreamMarker"',
      '"protectedPaths"',
      '".agents/knowledge/**"',
    ],
    reason:
      "branding config exists, declares the keep-upstream marker, and protects .agents/knowledge",
  },
  {
    file: "aura/CONFLICT_WATCHLIST.md",
    must: ["update-checker.ts", "ws-bridge.ts", "session-state-machine.ts", "Sidebar.tsx"],
    reason:
      "watchlist documents every interleaved hotspot — each new merge tool relies on it",
  },
  {
    file: "web/server/index.ts",
    must: ["/ready", "isReady"],
    reason:
      "Aura's deploy resilience uses /ready (poll target for the restart wrapper) — Deploy D5",
  },
  {
    file: "scripts/aura-restart.sh",
    must: ["/ready", "PIDFILE", "setsid"],
    reason:
      "Aura's restart wrapper is the smallest fix for restart fragility — Deploy D4",
  },
  {
    file: "web/scripts/aura-drift-check.ts",
    must: [
      "the-companion",
      "registry.npmjs.org",
      "ISSUE_TITLE_PREFIX",
      "computeReport",
    ],
    reason:
      "Drift detector: read-only oracle against upstream npm + GitHub, deduped via title — Task 15",
  },
  {
    file: "docs/aura/upstream-sync.md",
    must: ["Conflict rule of thumb", "blast-radius first", "branding script"],
    reason:
      "Five-step sync workflow — survives in maintainer memory only via this doc",
  },
];

describe("aura watchlist sentinels", () => {
  for (const sentinel of SENTINELS) {
    describe(sentinel.file, () => {
      it("file exists", () => {
        const path = resolve(REPO_ROOT, sentinel.file);
        expect(existsSync(path), `${sentinel.file} is gone`).toBe(true);
      });

      for (const marker of sentinel.must) {
        it(`contains \`${marker}\``, () => {
          // If a sentinel disappears, the failure message tells the
          // maintainer (a) which file lost it, (b) which marker is gone,
          // and (c) why it matters — so they can either restore it or
          // intentionally update SENTINELS + watchlist.
          const path = resolve(REPO_ROOT, sentinel.file);
          const content = readFileSync(path, "utf-8");
          expect(
            content.includes(marker),
            `${sentinel.file} no longer contains "${marker}".\n` +
              `Reason this matters: ${sentinel.reason}\n` +
              `If this removal is intentional, update SENTINELS in aura-watchlist-guard.test.ts AND aura/CONFLICT_WATCHLIST.md.`,
          ).toBe(true);
        });
      }
    });
  }
});
