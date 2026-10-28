# Telegram Mini App — platform rules

Platform: telegram-mini-app

## When this applies

The screen runs inside Telegram as a Mini App: it loads `telegram-web-app.js` or an `@telegram-apps/*` package, or calls `Telegram.WebApp`. It is a web page, but Telegram owns the frame, the back control, the bottom buttons, the colours and the dialogs. Web-only habits (an in-page back arrow, a fixed footer button, a hard-coded palette, `window.confirm`) are defects here.

## Addendum (2026-10-28) — host controls, not page controls

Source: telegram-webapps, tma-js

- **Back.** Show Telegram's BackButton whenever the user is below the first screen, hide it on the first screen, and route its click event to your own history. The button does nothing by itself; an unhandled click is a dead control. Never draw a second back arrow in the page.
- **Primary action.** Put the screen's one primary action in the bottom bar button (MainButton, called BottomButton in newer Bot API versions), with an optional SecondaryButton for the alternative. Set its text to the verb, disable it while the form is invalid and show its progress state while the request runs. A page-drawn sticky footer button duplicates it and collides with it.
- **Dialogs.** Use the host popups (`showPopup`, `showConfirm`, `showAlert`) for confirmations; they match the client and work with the system back gesture. Browser `alert`/`confirm` are blocked or look foreign in several clients.
- **Leaving with unsaved input.** Turn on closing confirmation while a form is dirty and turn it off once it is saved, so a swipe-down does not silently discard the user's work.
- **Vertical swipes.** If the screen scrolls or drags vertically (maps, sliders, long lists), disable vertical swipes for that screen so a scroll does not collapse the app; restore them afterwards.
- **Versions.** Each of these APIs arrived in a specific Bot API version. Gate every call with `isVersionAtLeast` and keep a working fallback for older clients.

## Addendum (2026-10-28) — viewport, safe areas and keyboard

Source: telegram-webapps, tma-js

- Size the layout from the stable viewport height (`viewportStableHeight`, CSS `var(--tg-viewport-stable-height)`), not from `100vh`; the live height changes during the expand gesture and makes bottom-pinned content jump.
- Pad content by both insets: the device safe area (`--tg-safe-area-inset-*`) and the content safe area that Telegram's own controls occupy (`--tg-content-safe-area-inset-*`). This matters most in full-screen mode, where the header controls overlap the page.
- Call `expand()` early when the screen needs full height. When the on-screen keyboard opens, keep the focused field and the bottom button visible; call `hideKeyboard` (newer clients) after submit.

## Addendum (2026-10-28) — theme and feedback

Source: telegram-webapps, tma-js, telegram-ui

- Take every colour from `themeParams` (CSS `--tg-theme-*`): background, secondary background, section background, text, hint, link, button and button text, accent, destructive, header and bottom-bar colours. Listen for `themeChanged` and re-render; a user can switch to night mode while the app is open.
- Match the header and bottom-bar colours to the page (`setHeaderColor`, `setBackgroundColor`, `setBottomBarColor`) so the frame does not show a seam.
- Use haptic feedback sparingly: impact for a confirmed tap, notification for success or error, selection change for pickers.
- Telegram asks for smooth (ideally 60 fps) motion, mobile-first layouts, labels on every input and image, and fewer effects on low-performance Android devices.

## Addendum (2026-10-28) — touch targets inside Telegram

Source: wcag-22, apple-hig, material-3

The Mini App is used with a finger on the host OS. Size targets to the host: 44×44 pt on iOS, 48×48 dp on Android. WCAG's 24×24 CSS px is only the legal floor.

## Source conflicts

- **Claim:** Minimum touch target size
  **Sources:** wcag-22, apple-hig, material-3, telegram-webapps
  **Default:** 44×44 CSS px for every tappable element. That meets iOS 44 pt; on Android, 48 px wherever the layout allows.
  **Reason:** A Mini App cannot tell which host it runs in before layout without reading the platform field, and the 24 px WCAG floor is a legal minimum, not a comfortable target for a thumb.
  **Platform scope:** telegram-mini-app
- **Claim:** Who owns back navigation
  **Sources:** telegram-webapps, material-3, apple-hig
  **Default:** Telegram BackButton only; no in-page back arrow and no reliance on the browser history.
  **Reason:** The host already shows a back control and maps the system gesture to it; a second control conflicts with it and breaks the gesture.
  **Platform scope:** telegram-mini-app
