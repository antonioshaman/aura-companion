// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";
import { axe } from "vitest-axe";

/**
 * The shared `sign_in` action button (phase 2c, task 12): every entry point
 * opens the ONE sign-in window through the store. "Continue" only reads the
 * running attempt (resume); every other mode asks the server to start (it
 * answers with the running attempt if one exists).
 */

import { SignInButton, signInButtonLabel } from "./SignInButton.js";
import { useStore } from "../../store.js";
import { PROVIDER_IDS } from "../../../server/auth-status/auth-types.js";

beforeEach(() => useStore.getState().closeLoginDialog());

describe("SignInButton", () => {
  it("renders the label per mode and provider, axe-clean", async () => {
    const { container } = render(
      <div>
        {PROVIDER_IDS.map((p) => (
          <SignInButton key={p} provider={p} mode="sign_in" className="x" />
        ))}
      </div>,
    );
    expect(screen.getByRole("button", { name: "Sign in to Claude" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in to Codex" })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    expect(signInButtonLabel("sign_in_again", "codex")).toBe("Sign in to Codex again");
    expect(signInButtonLabel("another_account", "claude")).toBe("Sign in with another account");
  });

  it("click opens the window: start for sign-in, resume for continue", () => {
    const { rerender } = render(<SignInButton provider="claude" className="x" />);
    fireEvent.click(screen.getByRole("button"));
    expect(useStore.getState().loginDialog).toEqual({ provider: "claude", intent: "start", collapsed: false });
    rerender(<SignInButton provider="codex" mode="continue" className="x" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue Codex sign-in" }));
    expect(useStore.getState().loginDialog).toEqual({ provider: "codex", intent: "resume", collapsed: false });
  });
});
