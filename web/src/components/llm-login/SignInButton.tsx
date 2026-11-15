import { useStore } from "../../store.js";
import type { ProviderId } from "../../../server/auth-status/auth-types.js";
import { providerLabel } from "../../../server/auth-status/auth-catalog.js";

/**
 * The `sign_in` action as a button (LLM auth phase 2c, task 12): every entry
 * point — Diagnostics card, turn-failure card, usage-limits reason — opens
 * the same sign-in window. `continue` re-opens a running attempt (read only);
 * the others ask the server to start one (it answers with the running one if
 * there is one, so a second attempt never starts).
 */
export type SignInButtonMode = "sign_in" | "sign_in_again" | "continue" | "another_account";

export function signInButtonLabel(mode: SignInButtonMode, provider: ProviderId): string {
  switch (mode) {
    case "sign_in":
      return `Sign in to ${providerLabel(provider)}`;
    case "sign_in_again":
      return `Sign in to ${providerLabel(provider)} again`;
    case "continue":
      return `Continue ${providerLabel(provider)} sign-in`;
    case "another_account":
      return "Sign in with another account";
    default: {
      const never: never = mode;
      throw new Error(`unhandled sign-in button mode ${String(never)}`);
    }
  }
}

export function SignInButton({ provider, mode = "sign_in_again", className }: { provider: ProviderId; mode?: SignInButtonMode; className: string }) {
  return (
    <button
      type="button"
      className={className}
      data-testid={`sign-in-button-${provider}`}
      onClick={() => useStore.getState().openLoginDialog(provider, mode === "continue" ? "resume" : "start")}
    >
      {signInButtonLabel(mode, provider)}
    </button>
  );
}
