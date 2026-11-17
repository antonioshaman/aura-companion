import { useState } from "react";
import { secondaryButtonClass } from "./buttons.js";

/**
 * One copy button for the sign-in journey. `navigator.clipboard` exists only
 * in a secure context: on `http://<server-ip>:3456` (how a remote first run
 * looks) it is undefined, and calling it threw inside the click handler, so
 * the wizard's Copy silently did nothing (council review 2026-11-15, abramov
 * A4). Here a missing or refused clipboard says "select it by hand".
 */
export function CopyButton({ value, label, ariaLabel, className }: { value: string; label: string; ariaLabel?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const onClick = () => {
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clip) {
      setState("failed");
      return;
    }
    clip.writeText(value).then(
      () => setState("copied"),
      () => setState("failed"),
    );
  };
  const text = state === "copied" ? "Copied" : state === "failed" ? "Copy failed — select it by hand" : label;
  return (
    <>
      <button type="button" className={className ?? secondaryButtonClass} onClick={onClick} aria-label={state === "idle" ? ariaLabel : undefined}>
        {text}
      </button>
      {/* A focused button's changed name is rarely re-announced: say the
          result in a status region mounted with the button (watson P3-2). */}
      <span role="status" className="sr-only">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed — select it by hand" : ""}</span>
    </>
  );
}
