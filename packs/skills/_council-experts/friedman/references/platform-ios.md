# friedman — iOS flows

Platform: ios

## When this applies

The screen ships as an iOS or iPadOS app, or a cross-platform shell presented as one. Judge navigation and modality by iOS conventions, not web ones.

## Addendum (2026-10-28) — flow checks for iOS

Source: apple-hig

- **Back.** Navigation-bar back plus the edge swipe; a blocked swipe or a second in-content back control is **P2**.
- **Tab bar navigates, never acts.** A tab that opens a composer or triggers an action is **P2**. Switching tabs keeps each tab's navigation state.
- **Modality fits the task.** Sheets for short self-contained tasks (medium or large detent), full-screen modals only for immersive or multi-step work with an obvious Done/Cancel. Dismissing a sheet with unsaved input without confirmation is **P1**.
- **Destructive choices** go in an action sheet attached to the control that started them, with Cancel apart at the bottom; alerts only for what must be known now.
- **Permissions** are requested when the feature is first used, or in onboarding after the benefit is explained. A cold system prompt at launch is **P2**.
- **Gestures have buttons.** Every swipe action also exists as a visible control.

## Source conflicts

None between the sources used here.
