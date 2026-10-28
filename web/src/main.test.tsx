// @vitest-environment jsdom
/**
 * Entry point boot order: analytics, then the iOS input-zoom guard (which
 * replaced `maximum-scale=1` in index.html, so pinch-zoom stays available),
 * then the React root inside the error boundary, then the lazy SW register.
 * App, analytics and the SW are mocked: only the wiring is under test here.
 */
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);

vi.mock("./App.js", () => ({ default: () => <p>app</p> }));
vi.mock("./analytics.js", () => ({ initAnalytics: () => calls.push("analytics") }));
vi.mock("./components/AppErrorBoundary.js", () => ({
  AppErrorBoundary: ({ children }: { children: unknown }) => <div data-testid="boundary">{children as never}</div>,
}));
vi.mock("./index.css", () => ({}));
vi.mock("./utils/viewport.js", () => ({ applyIosInputZoomGuard: () => calls.push("zoom-guard") }));
vi.mock("./sw-register.js", () => {
  calls.push("sw-register");
  return {};
});
const render = vi.fn();
vi.mock("react-dom/client", () => ({
  createRoot: (el: Element) => {
    calls.push(`root:${el.id}`);
    return { render };
  },
}));

describe("main.tsx", () => {
  it("boots analytics, the zoom guard and the root in order, then loads the SW register", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await import("./main.js");
    expect(calls.slice(0, 3)).toEqual(["analytics", "zoom-guard", "root:root"]);
    expect(render).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(calls).toContain("sw-register"));
  });
});
