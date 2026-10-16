// @vitest-environment jsdom
/**
 * Live-path regression for the observer findings cards (prod 2026-10-16,
 * observer 17fbf63f… in grp_879b81b6, bundle 8de9cf58).
 *
 * The cards from PR #358 never showed in the observer's chat: every findings
 * reply rendered as a collapsed "Ответ на пробу" row whose preview was the
 * raw JSON. Root cause: the observer's persisted history holds ONE
 * `[liveness probe]` user message, and a wake is never echoed into the feed
 * as a user message — so `probeMessageIds` ("every assistant message after a
 * probe up to the next user message") swallowed every later review.
 *
 * Unlike the unit tests (which hand-build ChatMessages and mock the store),
 * this drives the REAL recorded browser frames — a reduced `message_history`
 * replay of the persisted history plus the last findings turn verbatim
 * (stream deltas → content_block_stop → message_delta → assistant → result
 * → observer_review) — through the real ws handler and real Zustand store
 * into MessageFeed, exactly as a reloaded tab receives them.
 */
import { act, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { axe } from "vitest-axe";
import recordingRaw from "../__fixtures__/observer-findings/codex-observer-findings-after-probe.jsonl?raw";

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("remark-gfm", () => ({ default: {} }));
// Any REST call the ws handler / feed makes resolves to an empty payload.
vi.mock("../api.js", () => ({
  api: new Proxy({}, { get: () => vi.fn().mockResolvedValue({ groups: [], findings: [] }) }),
}));

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  static CLOSING = 2;
  OPEN = 1;
  CLOSED = 3;
  CONNECTING = 0;
  CLOSING = 2;
  readyState = MockWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string) {
    lastWs = this;
  }
}
let lastWs: MockWebSocket;
vi.stubGlobal("WebSocket", MockWebSocket);
// jsdom has no layout: the feed's auto-scroll calls scrollIntoView.
Element.prototype.scrollIntoView = vi.fn();

// Fresh modules per test: ws.ts keeps per-session module state (last seen
// `seq` — mirrored to localStorage —, streaming drafts) that would drop the
// replayed frames as duplicates.
let useStore: typeof import("../store.js").useStore;
let connectSession: typeof import("../ws.js").connectSession;
let MessageFeed: typeof import("./MessageFeed.js").MessageFeed;

const OBSERVER = "17fbf63f-0bea-490e-a0fb-62f6107b39ae";
const PRIMARY = "8b26ccb7-6181-4a5e-b0e2-f29461820d7c";
const GROUP = "grp_879b81b62a249c338531af67be1ed8fc";

/** Browser-bound frames of the fixture, in order (header line dropped). */
function recordedFrames(): Array<Record<string, unknown>> {
  return recordingRaw
    .split("\n")
    .filter((l) => l.trim())
    .slice(1)
    .map((l) => JSON.parse(l) as { dir: string; ch: string; raw: string })
    .filter((e) => e.dir === "out" && e.ch === "browser")
    .map((e) => JSON.parse(e.raw) as Record<string, unknown>);
}

function fire(frame: Record<string, unknown>) {
  act(() => {
    lastWs.onmessage!({ data: JSON.stringify(frame) });
  });
}

/** The REST group bootstrap (`GET /api/groups` → hydrateGroups), with the
 *  exact record prod served for this pair. */
function hydratePair(observerSessionId = OBSERVER) {
  useStore.getState().hydrateGroups([
    {
      sessionGroupId: GROUP,
      primarySessionId: PRIMARY,
      observerSessionId,
      pairing: "claude+codex",
      status: "active",
      wakeTimeoutMs: 300000,
    } as unknown as import("../types.js").GroupRecord,
  ]);
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  ({ useStore } = await import("../store.js"));
  ({ connectSession } = await import("../ws.js"));
  ({ MessageFeed } = await import("./MessageFeed.js"));
  useStore.getState().reset();
});

describe("observer findings cards — live frame path", () => {
  it("renders every findings reply as cards after a reload, even with a liveness probe earlier in history", async () => {
    hydratePair();
    connectSession(OBSERVER);
    const { container } = render(<MessageFeed sessionId={OBSERVER} />);

    for (const frame of recordedFrames()) fire(frame);

    // Both recorded reviews (the replayed one and the live one) are cards.
    const lists = screen.getAllByRole("list", { name: "Observer findings" });
    expect(lists).toHaveLength(2);
    expect(within(lists[0]).getAllByRole("listitem")).toHaveLength(2);
    expect(within(lists[0]).getByText(/^Дедупликация сравнивает/)).toBeInTheDocument();
    expect(within(lists[1]).getByText(/^Исправление учитывает/)).toBeInTheDocument();
    expect(within(lists[1]).getByText(".council/review-input/pr-372-fixpass.diff:96–104")).toBeInTheDocument();

    // The probe exchange itself is still collapsed as probe traffic — and
    // only it: exactly the probe + its prose answer.
    const probeRows = screen.getAllByTestId("observer-probe-message");
    expect(probeRows.map((r) => r.getAttribute("data-role"))).toEqual(["user", "assistant"]);

    // No raw JSON leaks into the feed text.
    expect(container.textContent).not.toContain('"severity"');
    expect(await axe(container)).toHaveNoViolations();
  });

  it("the streaming draft stays plain text until the final assistant frame lands", () => {
    hydratePair();
    connectSession(OBSERVER);
    render(<MessageFeed sessionId={OBSERVER} />);
    const frames = recordedFrames();
    const history = frames[0];
    fire(history);
    // Only the replayed review is a card while the live turn is streaming.
    const firstDelta = frames.findIndex(
      (f) => f.type === "stream_event" && (f.event as { type?: string }).type === "content_block_delta",
    );
    const final = frames.findIndex((f) => f.type === "assistant");
    for (const f of frames.slice(firstDelta, final)) fire(f);
    expect(screen.getAllByRole("list", { name: "Observer findings" })).toHaveLength(1);
    fire(frames[final]);
    expect(screen.getAllByRole("list", { name: "Observer findings" })).toHaveLength(2);
  });

  it("keeps the provenance gate: the same frames in a non-observer session render plain", () => {
    // The pair's observer is a different session — this one is the primary.
    hydratePair("some-other-observer");
    connectSession(OBSERVER);
    const { container } = render(<MessageFeed sessionId={OBSERVER} />);
    for (const frame of recordedFrames()) fire(frame);
    expect(screen.queryByRole("list", { name: "Observer findings" })).toBeNull();
    expect(screen.queryByTestId("observer-probe-message")).toBeNull();
    expect(container.textContent).toContain('"severity"');
  });
});
