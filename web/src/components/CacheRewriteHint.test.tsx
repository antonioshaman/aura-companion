// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

// W7(b) — subtle, non-blocking prompt-cache hint. It reads the two
// server-maintained cache fields from the session (last_context_tokens,
// last_turn_completed_at) and estimates how many tokens a cold cache will
// write again: after a >60 min pause (reason="idle") or right before a model
// switch (reason="model-switch"). It never blocks input — it is plain text.

interface MockSession { last_context_tokens?: number; last_turn_completed_at?: number }
let sessions: Map<string, MockSession>;

vi.mock("../store.js", () => ({
  useStore: (selector: (s: { sessions: Map<string, MockSession> }) => unknown) => selector({ sessions }),
}));

import { CacheRewriteHint } from "./CacheRewriteHint.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  sessions = new Map();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("CacheRewriteHint", () => {
  it("idle: shows the rewrite estimate after a >60 min pause with a large context", () => {
    sessions.set("s1", { last_context_tokens: 120_000, last_turn_completed_at: NOW - 75 * 60_000 });
    render(<CacheRewriteHint sessionId="s1" reason="idle" />);
    const hint = screen.getByTestId("cache-rewrite-hint");
    expect(hint).toHaveTextContent("Кеш истёк (пауза 75 мин): ≈120.0k токенов будут записаны заново");
  });

  it("idle: renders nothing while the cache is still warm or the context is small", () => {
    sessions.set("warm", { last_context_tokens: 120_000, last_turn_completed_at: NOW - 10 * 60_000 });
    sessions.set("small", { last_context_tokens: 5_000, last_turn_completed_at: NOW - 5 * 3_600_000 });
    const { container: a } = render(<CacheRewriteHint sessionId="warm" reason="idle" />);
    const { container: b } = render(<CacheRewriteHint sessionId="small" reason="idle" />);
    expect(a).toBeEmptyDOMElement();
    expect(b).toBeEmptyDOMElement();
  });

  it("idle: appears on its own once the TTL elapses while the composer stays open", () => {
    // Interaction over time: the hint re-evaluates on a minute tick, so a user
    // who left the tab open sees it without typing or reloading.
    sessions.set("s1", { last_context_tokens: 50_000, last_turn_completed_at: NOW - 59 * 60_000 });
    render(<CacheRewriteHint sessionId="s1" reason="idle" />);
    expect(screen.queryByTestId("cache-rewrite-hint")).toBeNull();
    // Two minute ticks (fake Date advances with the timers) → 61 min idle.
    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(screen.getByTestId("cache-rewrite-hint")).toHaveTextContent("пауза 61 мин");
  });

  it("model-switch: warns the switch resets the cache regardless of idle time", () => {
    sessions.set("s1", { last_context_tokens: 80_000, last_turn_completed_at: NOW - 60_000 });
    render(<CacheRewriteHint sessionId="s1" reason="model-switch" />);
    expect(screen.getByTestId("cache-rewrite-hint"))
      .toHaveTextContent("Смена модели сбросит кеш: ≈80.0k токенов будут записаны заново");
  });

  it("passes axe accessibility checks", async () => {
    vi.useRealTimers();
    const { axe } = await import("vitest-axe");
    sessions.set("s1", { last_context_tokens: 120_000, last_turn_completed_at: Date.now() - 3 * 3_600_000 });
    const { container } = render(<CacheRewriteHint sessionId="s1" reason="idle" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
