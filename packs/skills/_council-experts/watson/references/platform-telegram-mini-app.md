# watson — Telegram Mini App accessibility

Platform: telegram-mini-app

## When this applies

The screen is a Telegram Mini App: a web view inside Telegram on iOS, Android or desktop. WCAG still applies, and the host OS settings shape what users need.

## Addendum (2026-10-28) — contrast in both themes, host-sized targets

Source: telegram-webapps, wcag-22, apple-hig, material-3

- **Contrast in both themes.** `themeParams` differ per user theme and client. Check text on `bg_color`, `secondary_bg_color` and `section_bg_color`, `hint_color` text, and `button_text_color` on `button_color`, in light and dark. A pairing below 4.5:1 for body text is **P1**; the app's own colours layered on the host theme must be checked against both.
- **Targets sized to the host.** At least 44×44 CSS px for every tappable element (iOS 44 pt; 48 px on Android where it fits). 24 px is the WCAG 2.5.8 floor only.
- **Labels.** Telegram's guidelines require labels on every input and image; a control announced only as "button" is **P1**.
- **Text size.** The web view follows the client's text scale in some clients; layouts must survive 200% text without clipping (WCAG 1.4.4).
- **Forced colours.** On Telegram Desktop under Windows high-contrast mode (`forced-colors: active`), custom controls keep a visible border and focus outline (WCAG 1.4.11 non-text contrast).
- **Motion.** Respect `prefers-reduced-motion`; haptics never replace a visible state change.

## Source conflicts

None between the sources used here.
