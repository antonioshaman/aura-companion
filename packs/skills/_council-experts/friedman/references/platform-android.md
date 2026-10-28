# friedman — Android flows

Platform: android

## When this applies

The screen ships as an Android app, or a cross-platform shell presented as one. Judge navigation and messaging by Material 3, not web habits.

## Addendum (2026-10-28) — flow checks for Android

Source: material-3

- **Back is the system's.** System back and predictive back return to the previous destination and dismiss sheets and dialogs. Intercepting back without a reason, or adding an in-content back control, is **P2**.
- **Navigation by window size.** Navigation bar for three to five destinations in compact and medium widths, navigation rail in expanded widths. More than five bar items, or a bar used for actions, is **P2**.
- **Pick the message component by importance.** Snackbar for low-importance feedback with an optional single action such as Undo; dialog only for a decision that must interrupt, with at most two actions. A dialog for "Saved" is **P2**.
- **Bottom sheets** for long action lists on phones, dismissible by scrim tap, swipe down or back.

## Source conflicts

None between the sources used here.
