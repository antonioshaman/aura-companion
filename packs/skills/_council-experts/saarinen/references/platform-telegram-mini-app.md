# saarinen — Telegram Mini App visual craft

Platform: telegram-mini-app

## When this applies

The screen is a Telegram Mini App. It should look like part of the Telegram client in both themes, not like a website framed inside it.

## Addendum (2026-10-28) — inherit the host, then add restraint

Source: telegram-webapps, telegram-ui

- **Every colour from `themeParams`.** Background, secondary and section backgrounds, text, hint, link, accent, button, destructive, header and bottom-bar colours come from `--tg-theme-*`, re-read on `themeChanged`. A hard-coded palette that breaks in night mode is **P2**.
- **No seam at the frame.** Header, background and bottom-bar colours are set to match the page, so the client chrome and the app read as one surface. A visible colour band under the header is **P3**.
- **Sections like the client.** Group settings and lists in section blocks on the secondary background, with section headers in the section-header colour and separators in the separator colour, as the TelegramUI kit does. Cards with heavy shadows and gradients look foreign: **P3**.
- **Own brand colour sparingly.** Use it for the one accent the host does not provide, never for backgrounds.
- **Motion** is short and smooth; trim effects on low-performance Android devices.

## Source conflicts

None between the sources used here.
