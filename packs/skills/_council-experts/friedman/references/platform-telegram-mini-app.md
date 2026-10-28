# friedman — Telegram Mini App flows

Platform: telegram-mini-app

## When this applies

The reviewed or planned screen is a Telegram Mini App. Review its flow against the host's controls; Telegram owns back, the primary button, dialogs and closing.

## Addendum (2026-10-28) — flow checks for Mini Apps

Source: telegram-webapps, tma-js

- **Back is Telegram's.** BackButton is shown below the first screen, hidden on it, and wired to the app's history. An in-page back arrow, or a BackButton whose click does nothing, is **P2**.
- **One primary action, in the bottom bar.** The step's primary action is the MainButton (BottomButton) with a verb label, disabled while the input is invalid and showing progress while it runs; the optional SecondaryButton holds the alternative. A page-drawn sticky CTA next to it is **P2**; two competing primaries are **P1** on a payment or destructive step.
- **Confirm with host popups.** `showConfirm`/`showPopup` for destructive or money-moving confirmations, naming the object. Browser `confirm()` is **P2**.
- **Do not lose input.** Closing confirmation is on while a form is dirty and off after save. A swipe-down that silently drops a filled form is **P1**.
- **Keyboard.** The focused field and the bottom button stay visible above the on-screen keyboard; layouts are sized from the stable viewport height, not `100vh`.
- **Old clients.** Calls are gated with `isVersionAtLeast`, with a fallback path. A flow that dead-ends on an older client is **P2**.

## Source conflicts

None between the sources used here.
