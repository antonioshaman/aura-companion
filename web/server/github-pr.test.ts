import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExecSync = vi.hoisted(() => vi.fn());
const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
}));

// ---------------------------------------------------------------------------
// Module under test — re-imported to reset module-level caches
// ---------------------------------------------------------------------------
let mod: typeof import("./github-pr.js");

beforeEach(async () => {
  vi.resetModules();
  mockExecSync.mockReset();
  mockExecFileSync.mockReset();
  mod = await import("./github-pr.js");
});

// ---------------------------------------------------------------------------
// Sample GraphQL response (matches real GitHub API shape)
// ---------------------------------------------------------------------------

function makeGraphQLResponse(prOverrides?: Record<string, unknown>) {
  return {
    data: {
      repository: {
        pullRequests: {
          nodes: prOverrides === null ? [] : [{
            number: 162,
            title: "feat: add dark mode toggle",
            url: "https://github.com/org/repo/pull/162",
            state: "OPEN",
            isDraft: false,
            isCrossRepository: false,
            reviewDecision: "CHANGES_REQUESTED",
            additions: 91,
            deletions: 88,
            changedFiles: 24,
            reviewThreads: {
              totalCount: 4,
              nodes: [
                { isResolved: true },
                { isResolved: true },
                { isResolved: false },
                { isResolved: false },
              ],
            },
            commits: {
              nodes: [{
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        { __typename: "CheckRun", name: "CI / Build", status: "COMPLETED", conclusion: "SUCCESS" },
                        { __typename: "CheckRun", name: "CI / Test", status: "COMPLETED", conclusion: "FAILURE" },
                        { __typename: "StatusContext", context: "deploy/preview", state: "SUCCESS" },
                      ],
                    },
                  },
                },
              }],
            },
            ...prOverrides,
          }],
        },
      },
    },
  };
}

// ===========================================================================
// isGhAvailable
// ===========================================================================
describe("isGhAvailable", () => {
  it("returns true when `which gh` succeeds", () => {
    mockExecSync.mockReturnValue("/opt/homebrew/bin/gh");
    expect(mod.isGhAvailable()).toBe(true);
  });

  it("returns false when `which gh` throws", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(mod.isGhAvailable()).toBe(false);
  });

  it("caches the result across calls", () => {
    mockExecSync.mockReturnValue("/opt/homebrew/bin/gh");
    mod.isGhAvailable();
    mod.isGhAvailable();
    // Only the first call for `which gh`; subsequent calls should be cached
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// parseGraphQLResponse
// ===========================================================================
describe("parseGraphQLResponse", () => {
  it("parses a full response with CheckRun and StatusContext nodes", () => {
    const result = mod.parseGraphQLResponse(makeGraphQLResponse());
    expect(result).not.toBeNull();
    expect(result!.number).toBe(162);
    expect(result!.title).toBe("feat: add dark mode toggle");
    expect(result!.state).toBe("OPEN");
    expect(result!.isDraft).toBe(false);
    expect(result!.reviewDecision).toBe("CHANGES_REQUESTED");
    expect(result!.additions).toBe(91);
    expect(result!.deletions).toBe(88);
    expect(result!.changedFiles).toBe(24);
  });

  it("computes checksSummary correctly", () => {
    const result = mod.parseGraphQLResponse(makeGraphQLResponse())!;
    expect(result.checksSummary).toEqual({
      total: 3,
      success: 2,  // CI/Build SUCCESS + deploy/preview SUCCESS
      failure: 1,  // CI/Test FAILURE
      pending: 0,
    });
  });

  it("normalizes StatusContext into check format", () => {
    const result = mod.parseGraphQLResponse(makeGraphQLResponse())!;
    const deployCheck = result.checks.find((c) => c.name === "deploy/preview");
    expect(deployCheck).toEqual({
      name: "deploy/preview",
      status: "COMPLETED",
      conclusion: "SUCCESS",
    });
  });

  it("computes reviewThreads correctly", () => {
    const result = mod.parseGraphQLResponse(makeGraphQLResponse())!;
    expect(result.reviewThreads).toEqual({
      total: 4,
      resolved: 2,
      unresolved: 2,
    });
  });

  it("returns null for empty PR nodes", () => {
    const result = mod.parseGraphQLResponse(makeGraphQLResponse(null as any));
    expect(result).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(mod.parseGraphQLResponse(null)).toBeNull();
    expect(mod.parseGraphQLResponse(undefined)).toBeNull();
    expect(mod.parseGraphQLResponse("not json")).toBeNull();
    expect(mod.parseGraphQLResponse({ data: null })).toBeNull();
  });

  it("handles PR with no checks (statusCheckRollup null)", () => {
    const result = mod.parseGraphQLResponse(makeGraphQLResponse({
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    }))!;
    expect(result.checks).toEqual([]);
    expect(result.checksSummary).toEqual({ total: 0, success: 0, failure: 0, pending: 0 });
  });

  it("handles PR with no review threads", () => {
    const result = mod.parseGraphQLResponse(makeGraphQLResponse({
      reviewThreads: { totalCount: 0, nodes: [] },
    }))!;
    expect(result.reviewThreads).toEqual({ total: 0, resolved: 0, unresolved: 0 });
  });

  it("handles pending StatusContext (PENDING state)", () => {
    const result = mod.parseGraphQLResponse(makeGraphQLResponse({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  { __typename: "StatusContext", context: "ci/deploy", state: "PENDING" },
                ],
              },
            },
          },
        }],
      },
    }))!;
    expect(result.checks[0]).toEqual({
      name: "ci/deploy",
      status: "IN_PROGRESS",
      conclusion: null,
    });
    expect(result.checksSummary.pending).toBe(1);
  });

  it("counts NEUTRAL and SKIPPED as success", () => {
    const result = mod.parseGraphQLResponse(makeGraphQLResponse({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  { __typename: "CheckRun", name: "optional", status: "COMPLETED", conclusion: "NEUTRAL" },
                  { __typename: "CheckRun", name: "skipped", status: "COMPLETED", conclusion: "SKIPPED" },
                ],
              },
            },
          },
        }],
      },
    }))!;
    expect(result.checksSummary.success).toBe(2);
    expect(result.checksSummary.failure).toBe(0);
  });

  it("treats StatusContext ERROR state as failure", () => {
    const result = mod.parseGraphQLResponse(makeGraphQLResponse({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  { __typename: "StatusContext", context: "ci/build", state: "ERROR" },
                ],
              },
            },
          },
        }],
      },
    }))!;
    expect(result.checks[0]).toEqual({
      name: "ci/build",
      status: "COMPLETED",
      conclusion: "FAILURE",
    });
    expect(result.checksSummary.failure).toBe(1);
    expect(result.checksSummary.pending).toBe(0);
  });

  it("counts CANCELLED and TIMED_OUT as failure", () => {
    const result = mod.parseGraphQLResponse(makeGraphQLResponse({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  { __typename: "CheckRun", name: "cancelled", status: "COMPLETED", conclusion: "CANCELLED" },
                  { __typename: "CheckRun", name: "timeout", status: "COMPLETED", conclusion: "TIMED_OUT" },
                ],
              },
            },
          },
        }],
      },
    }))!;
    expect(result.checksSummary.failure).toBe(2);
  });

  it("handles isDraft=true", () => {
    const result = mod.parseGraphQLResponse(makeGraphQLResponse({ isDraft: true }))!;
    expect(result.isDraft).toBe(true);
  });

  it("defaults isDraft to false when missing", () => {
    const response = makeGraphQLResponse();
    delete (response.data.repository.pullRequests.nodes[0] as any).isDraft;
    const result = mod.parseGraphQLResponse(response)!;
    expect(result.isDraft).toBe(false);
  });

  it("normalizes null reviewDecision", () => {
    const result = mod.parseGraphQLResponse(makeGraphQLResponse({ reviewDecision: null }))!;
    expect(result.reviewDecision).toBeNull();
  });

  it("normalizes empty string reviewDecision to null", () => {
    const result = mod.parseGraphQLResponse(makeGraphQLResponse({ reviewDecision: "" }))!;
    expect(result.reviewDecision).toBeNull();
  });

  it("parses a merged PR correctly", () => {
    const result = mod.parseGraphQLResponse(makeGraphQLResponse({
      state: "MERGED",
      reviewDecision: "APPROVED",
    }))!;
    expect(result).not.toBeNull();
    expect(result.state).toBe("MERGED");
    expect(result.reviewDecision).toBe("APPROVED");
  });

  it("filters out cross-repository (fork) PRs", () => {
    const response = {
      data: {
        repository: {
          pullRequests: {
            nodes: [
              { ...makeGraphQLResponse().data.repository.pullRequests.nodes[0], isCrossRepository: true, number: 100 },
              { ...makeGraphQLResponse().data.repository.pullRequests.nodes[0], isCrossRepository: false, number: 200 },
            ],
          },
        },
      },
    };
    const result = mod.parseGraphQLResponse(response)!;
    expect(result).not.toBeNull();
    expect(result.number).toBe(200);
  });

  it("returns null when all PRs are cross-repository", () => {
    const response = {
      data: {
        repository: {
          pullRequests: {
            nodes: [
              { ...makeGraphQLResponse().data.repository.pullRequests.nodes[0], isCrossRepository: true },
            ],
          },
        },
      },
    };
    const result = mod.parseGraphQLResponse(response);
    expect(result).toBeNull();
  });
});

// ===========================================================================
// fetchPRInfo
// ===========================================================================
describe("fetchPRInfo", () => {
  it("returns null when gh is not available", async () => {
    // First call: `which gh` throws
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    const result = await mod.fetchPRInfo("/some/path", "main");
    expect(result).toBeNull();
  });

  it("returns parsed PR info on success", async () => {
    // which gh + gh repo view use execSync; gh api graphql uses execFileSync
    mockExecSync
      .mockReturnValueOnce("/opt/homebrew/bin/gh")                                  // which gh
      .mockReturnValueOnce("git@github.com:The-Vibe-Company/companion.git");        // git remote get-url origin
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(makeGraphQLResponse())); // gh api graphql

    const result = await mod.fetchPRInfo("/project", "feat/dark-mode");
    expect(result).not.toBeNull();
    expect(result!.number).toBe(162);
    expect(result!.state).toBe("OPEN");
  });

  it("returns null when repo slug cannot be resolved", async () => {
    mockExecSync
      .mockReturnValueOnce("/opt/homebrew/bin/gh")  // which gh
      .mockImplementationOnce(() => { throw new Error("not a gh repo"); }); // gh repo view

    const result = await mod.fetchPRInfo("/not-a-repo", "main");
    expect(result).toBeNull();
  });

  it("returns null when graphql query fails", async () => {
    mockExecSync
      .mockReturnValueOnce("/opt/homebrew/bin/gh")       // which gh
      .mockReturnValueOnce("git@github.com:owner/repo.git");                // gh repo view
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error("timeout"); }); // gh api graphql

    const result = await mod.fetchPRInfo("/project", "main");
    expect(result).toBeNull();
  });

  it("returns null when no PR exists for branch", async () => {
    const emptyResponse = { data: { repository: { pullRequests: { nodes: [] } } } };
    mockExecSync
      .mockReturnValueOnce("/opt/homebrew/bin/gh")
      .mockReturnValueOnce("git@github.com:owner/repo.git");
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(emptyResponse));

    const result = await mod.fetchPRInfo("/project", "no-pr-branch");
    expect(result).toBeNull();
  });

  it("caches results within TTL", async () => {
    mockExecSync
      .mockReturnValueOnce("/opt/homebrew/bin/gh")
      .mockReturnValueOnce("git@github.com:owner/repo.git");
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify(makeGraphQLResponse()));

    const first = await mod.fetchPRInfo("/project", "feat/cached");
    const second = await mod.fetchPRInfo("/project", "feat/cached");

    expect(first).toEqual(second);
    // which gh (1) + repo view (1) = 2 execSync calls, graphql (1) = 1 execFileSync call
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns null for malformed JSON response", async () => {
    mockExecSync
      .mockReturnValueOnce("/opt/homebrew/bin/gh")
      .mockReturnValueOnce("git@github.com:owner/repo.git");
    mockExecFileSync
      .mockReturnValueOnce("NOT VALID JSON{{{");

    const result = await mod.fetchPRInfo("/project", "main");
    expect(result).toBeNull();
  });
});

// ===========================================================================
// computeAdaptiveTTL
// ===========================================================================
describe("computeAdaptiveTTL", () => {
  function makePR(overrides?: Partial<import("./github-pr.js").GitHubPRInfo>): import("./github-pr.js").GitHubPRInfo {
    return {
      number: 1,
      title: "test",
      url: "https://github.com/o/r/pull/1",
      state: "OPEN",
      isDraft: false,
      reviewDecision: null,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      checks: [],
      checksSummary: { total: 0, success: 0, failure: 0, pending: 0 },
      reviewThreads: { total: 0, resolved: 0, unresolved: 0 },
      ...overrides,
    };
  }

  it("returns 60s for null (no PR)", () => {
    expect(mod.computeAdaptiveTTL(null)).toBe(60_000);
  });

  it("returns 300s (5 min) for merged PR", () => {
    expect(mod.computeAdaptiveTTL(makePR({ state: "MERGED" }))).toBe(300_000);
  });

  it("returns 300s (5 min) for closed PR", () => {
    expect(mod.computeAdaptiveTTL(makePR({ state: "CLOSED" }))).toBe(300_000);
  });

  it("returns 10s for CI pending", () => {
    expect(mod.computeAdaptiveTTL(makePR({
      checksSummary: { total: 3, success: 1, failure: 0, pending: 2 },
    }))).toBe(10_000);
  });

  it("returns 30s for CI failed", () => {
    expect(mod.computeAdaptiveTTL(makePR({
      checksSummary: { total: 3, success: 2, failure: 1, pending: 0 },
    }))).toBe(30_000);
  });

  it("returns 30s for changes requested", () => {
    expect(mod.computeAdaptiveTTL(makePR({
      reviewDecision: "CHANGES_REQUESTED",
    }))).toBe(30_000);
  });

  it("returns 120s for approved with no pending checks", () => {
    expect(mod.computeAdaptiveTTL(makePR({
      reviewDecision: "APPROVED",
      checksSummary: { total: 2, success: 2, failure: 0, pending: 0 },
    }))).toBe(120_000);
  });

  it("returns 45s for review required", () => {
    expect(mod.computeAdaptiveTTL(makePR({
      reviewDecision: "REVIEW_REQUIRED",
    }))).toBe(45_000);
  });

  it("returns 45s for null reviewDecision (open PR)", () => {
    expect(mod.computeAdaptiveTTL(makePR({
      reviewDecision: null,
    }))).toBe(45_000);
  });

  it("pending checks take priority over review state", () => {
    expect(mod.computeAdaptiveTTL(makePR({
      reviewDecision: "CHANGES_REQUESTED",
      checksSummary: { total: 3, success: 1, failure: 0, pending: 2 },
    }))).toBe(10_000);
  });
});

// ─── parseGitRemoteOriginSlug — PR display fix 2026-05-15 ───────────────────
//
// The PR-display bug: Aura sidebar was showing upstream's PRs on a forked
// workspace because `gh repo view` defaulted to upstream. `getRepoSlug` now
// parses `git remote get-url origin` directly through this pure helper.
// Tests pin the parser against canonical GitHub remote-URL shapes plus
// negative cases.

describe("parseGitRemoteOriginSlug", () => {
  it("parses SSH form (git@github.com:owner/name.git)", () => {
    expect(mod.parseGitRemoteOriginSlug("git@github.com:antonioshaman/aura-companion.git")).toBe(
      "antonioshaman/aura-companion",
    );
  });

  it("parses HTTPS form (https://github.com/owner/name.git)", () => {
    expect(mod.parseGitRemoteOriginSlug("https://github.com/antonioshaman/aura-companion.git")).toBe(
      "antonioshaman/aura-companion",
    );
  });

  it("parses HTTPS form without .git suffix", () => {
    expect(mod.parseGitRemoteOriginSlug("https://github.com/antonioshaman/aura-companion")).toBe(
      "antonioshaman/aura-companion",
    );
  });

  it("parses ssh:// protocol form (ssh://git@github.com/owner/name.git)", () => {
    expect(mod.parseGitRemoteOriginSlug("ssh://git@github.com/antonioshaman/aura-companion.git")).toBe(
      "antonioshaman/aura-companion",
    );
  });

  it("trims surrounding whitespace and trailing newlines", () => {
    expect(mod.parseGitRemoteOriginSlug("  git@github.com:owner/name.git\n")).toBe("owner/name");
  });

  it("returns null on empty string", () => {
    expect(mod.parseGitRemoteOriginSlug("")).toBeNull();
  });

  it("returns null on non-string input", () => {
    expect(mod.parseGitRemoteOriginSlug(null as unknown as string)).toBeNull();
    expect(mod.parseGitRemoteOriginSlug(undefined as unknown as string)).toBeNull();
  });

  it("returns null on malformed URL with no owner/name segment", () => {
    expect(mod.parseGitRemoteOriginSlug("not-a-url")).toBeNull();
    expect(mod.parseGitRemoteOriginSlug("https://github.com/")).toBeNull();
  });

  it("distinguishes upstream slug from origin slug — parser is deterministic on input", () => {
    // The bug-class assertion: parser is pure on its input. The fix is at
    // the CALL SITE (`getRepoSlug` runs `git remote get-url origin`).
    // Pinning that both slugs parse correctly proves the parser doesn't
    // collapse to whichever GitHub host it sees.
    expect(mod.parseGitRemoteOriginSlug("git@github.com:The-Vibe-Company/companion.git")).toBe(
      "The-Vibe-Company/companion",
    );
    expect(mod.parseGitRemoteOriginSlug("git@github.com:antonioshaman/aura-companion.git")).toBe(
      "antonioshaman/aura-companion",
    );
  });
});

// ─── getRepoSlug — call-site canary ─────────────────────────────────────────

describe("getRepoSlug — call-site canary (uses git remote, not gh repo view)", () => {
  it("invokes `git remote get-url origin`, NOT `gh repo view`", async () => {
    // The PR-display bug was that the prior implementation shelled out to
    // `gh repo view --json nameWithOwner --jq .nameWithOwner`, which
    // delegates to gh's default-repo resolution (frequently upstream on a
    // forked workspace). The fix routes through git directly. This canary
    // pins the call site: both sync + async helpers must invoke
    // `git remote get-url origin` and NOT `gh repo view`.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(__dirname, "github-pr.ts"), "utf-8");

    function extractFunctionBody(anchor: RegExp): string | null {
      const match = anchor.exec(src);
      if (!match) return null;
      const openIdx = src.indexOf("{", match.index);
      if (openIdx < 0) return null;
      let depth = 1;
      for (let i = openIdx + 1; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
          depth--;
          if (depth === 0) return src.slice(openIdx, i + 1);
        }
      }
      return null;
    }

    const syncBody = extractFunctionBody(/\bfunction\s+getRepoSlug\s*\([^)]*\)\s*:?\s*[^{]*\{/);
    const asyncBody = extractFunctionBody(/\basync\s+function\s+getRepoSlugAsync\s*\([^)]*\)\s*:?\s*[^{]*\{/);
    expect(syncBody, "getRepoSlug body must be locatable").not.toBeNull();
    expect(asyncBody, "getRepoSlugAsync body must be locatable").not.toBeNull();

    // Positive: both must invoke `git remote get-url origin`.
    expect(syncBody!).toMatch(/git\s+remote\s+get-url\s+origin/);
    expect(asyncBody!).toMatch(/"git",\s*"remote",\s*"get-url",\s*"origin"/);

    // Negative: NEITHER body may shell out to `gh repo view` — that's the
    // regression path that returns upstream's slug on a fork.
    expect(syncBody!).not.toMatch(/gh\s+repo\s+view/);
    expect(asyncBody!).not.toMatch(/"gh",\s*"repo",\s*"view"/);
  });
});
