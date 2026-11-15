// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import "vitest-axe/extend-expect";
import { axe } from "vitest-axe";
import { useStore } from "../../store.js";
import { CredentialRenewalBanner, CredentialRenewalNotice } from "./CredentialRenewalNotice.js";
import { describeSessionReconnectFailed, describeSessionReconnecting } from "../../../server/auth-status/auth-catalog.js";

/**
 * "Reconnecting with the new sign-in…" (LLM auth phase 2d, task 14). Driven
 * by the session's persisted `credential_renewal` record (so a reload still
 * shows it); `renewed` shows nothing; `failed` says so as a warning. The
 * notice has no buttons: typing stays possible, the server holds the input.
 */

const SID = "s-renew";

beforeEach(() => {
  useStore.getState().reset();
});

function setRecord(record: unknown) {
  useStore.getState().addSession({ session_id: SID } as never);
  useStore.getState().updateSession(SID, { credential_renewal: record } as never);
}

describe("CredentialRenewalBanner", () => {
  it("reconnecting: title + 'keep typing' detail, a polite live status", () => {
    render(<CredentialRenewalBanner record={{ provider: "codex", promotedAt: 1, state: "reconnecting" }} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("data-state", "reconnecting");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText(describeSessionReconnecting("codex").title)).toBeInTheDocument();
    expect(screen.getByText(describeSessionReconnecting("codex").detail)).toBeInTheDocument();
  });

  it("failed: the reconnect-failed text", () => {
    render(<CredentialRenewalBanner record={{ provider: "claude", promotedAt: 1, state: "failed" }} />);
    expect(screen.getByText(describeSessionReconnectFailed("claude").title)).toBeInTheDocument();
  });

  it("renewed: nothing", () => {
    const { container } = render(<CredentialRenewalBanner record={{ provider: "claude", promotedAt: 1, state: "renewed" }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is axe-clean in both states for both providers", async () => {
    const { container } = render(
      <div>
        <CredentialRenewalBanner record={{ provider: "claude", promotedAt: 1, state: "reconnecting" }} />
        <CredentialRenewalBanner record={{ provider: "codex", promotedAt: 1, state: "failed" }} />
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("CredentialRenewalNotice (store-connected)", () => {
  it("follows the session record: shown while reconnecting, gone once renewed", () => {
    setRecord({ provider: "claude", promotedAt: 5, state: "reconnecting" });
    const { rerender } = render(<CredentialRenewalNotice sessionId={SID} />);
    expect(screen.getByTestId("credential-renewal-notice")).toBeInTheDocument();
    useStore.getState().updateSession(SID, { credential_renewal: { provider: "claude", promotedAt: 5, state: "renewed" } } as never);
    rerender(<CredentialRenewalNotice sessionId={SID} />);
    expect(screen.queryByTestId("credential-renewal-notice")).toBeNull();
  });

  it("renders nothing without a record", () => {
    const { container } = render(<CredentialRenewalNotice sessionId="none" />);
    expect(container).toBeEmptyDOMElement();
  });
});
