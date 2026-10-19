// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SectionErrorBoundary } from "./SectionErrorBoundary.js";

// The boundary logs caught errors through analytics.captureException — mock it
// so we can assert the boundary LOGS (does not swallow) without a real backend.
const captureExceptionMock = vi.fn();
vi.mock("../analytics.js", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}));

// Suppress React error boundary console.error noise during tests
vi.spyOn(console, "error").mockImplementation(() => {});

function ThrowingChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("test crash");
  return <div>child content</div>;
}

describe("SectionErrorBoundary", () => {
  it("renders children when no error occurs", () => {
    render(
      <SectionErrorBoundary label="Test">
        <div>hello</div>
      </SectionErrorBoundary>,
    );
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("shows fallback UI with label when child throws", () => {
    render(
      <SectionErrorBoundary label="Usage Limits">
        <ThrowingChild shouldThrow />
      </SectionErrorBoundary>,
    );
    expect(screen.getByText("Usage Limits failed to load")).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("shows generic fallback when no label provided", () => {
    render(
      <SectionErrorBoundary>
        <ThrowingChild shouldThrow />
      </SectionErrorBoundary>,
    );
    expect(screen.getByText("Section failed to load")).toBeTruthy();
  });

  it("resets error state when Retry button is clicked", () => {
    // Render with throwing child — should show error fallback
    render(
      <SectionErrorBoundary label="Test">
        <ThrowingChild shouldThrow />
      </SectionErrorBoundary>,
    );

    expect(screen.getByText("Test failed to load")).toBeTruthy();

    // Click Retry resets hasError, React tries to render children again.
    // Since ThrowingChild still throws, it catches again and shows fallback.
    // This verifies that clicking Retry doesn't crash and the boundary handles re-throws.
    fireEvent.click(screen.getByText("Retry"));

    // Error boundary should catch the re-throw and show fallback again
    expect(screen.getByText("Test failed to load")).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  // RC-1 T13 / RC-5 — the whole point of wrapping ObserverPanel / BlockerBanner /
  // ChatView: a throw inside the boundary must be CONTAINED. It must NOT unmount
  // a sibling rendered outside the boundary (which, in the live tree, would be
  // the escape-to-root-AppErrorBoundary path that blanked the viewport).
  it("contains a child throw without unmounting siblings outside the boundary", () => {
    render(
      <div>
        <div data-testid="outside-sibling">sibling stays mounted</div>
        <SectionErrorBoundary label="Observer">
          <ThrowingChild shouldThrow />
        </SectionErrorBoundary>
      </div>,
    );

    // Boundary caught the throw and shows its local fallback...
    expect(screen.getByText("Observer failed to load")).toBeTruthy();
    // ...and the sibling OUTSIDE the boundary is still in the DOM (blast radius
    // is section-local, not the whole app).
    expect(screen.getByTestId("outside-sibling")).toBeTruthy();
    expect(screen.getByText("sibling stays mounted")).toBeTruthy();
  });

  // The boundary must LOG the error (not swallow silently) — componentDidCatch
  // forwards to analytics.captureException with the section label as context.
  it("logs the caught error via captureException with the section label", () => {
    captureExceptionMock.mockClear();
    render(
      <SectionErrorBoundary label="Observer">
        <ThrowingChild shouldThrow />
      </SectionErrorBoundary>,
    );
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("test crash");
    expect(ctx).toMatchObject({ section: "Observer" });
  });

  it("fallback UI passes an axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <SectionErrorBoundary label="Observer">
        <ThrowingChild shouldThrow />
      </SectionErrorBoundary>,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
