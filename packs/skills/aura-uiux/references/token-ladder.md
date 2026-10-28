# Token ladder — semantic tokens and dark-mode elevation

Platform: all

## When this applies

A UI defines or changes its colour, surface or elevation tokens, adds a dark theme, or a review finds raw hex values in components. Read it before choosing colours; the visual skills say what looks right, this file says how to name and layer it.

## Addendum (2026-10-28) — three tiers of tokens

Source: design-tokens-format, style-dictionary, shadcn-ui

1. **Primitive.** Raw values with no meaning: `blue.600`, `gray.50`. Components never read these.
2. **Semantic.** A role with a job: `bg.app`, `bg.surface`, `border.subtle`, `text.primary`, `text.muted`, `accent.solid`, `danger.text`. A semantic token is an alias of a primitive, so a theme swap changes the alias, not the components.
3. **Component.** Optional, only when a component needs its own knob (`button.primary.bg` → `accent.solid`).

Pair every background role with the foreground role that sits on it (`primary` and `primary-foreground`), so text colour is never chosen ad hoc. Keep tokens in one source file in a standard format (a value plus a type per token, aliases by reference) and generate CSS variables and native constants from it.

## Addendum (2026-10-28) — a 12-step scale with a job per step

Source: radix-colors

Give each hue (including the neutral) twelve steps, each with one job: steps 1–2 app and subtle backgrounds; 3–5 component backgrounds at rest, hover and pressed or selected; 6–8 borders from subtle to strong, including focus rings; 9–10 solid fills and their hover; 11–12 low- and high-contrast text. A dark theme is a second twelve-step set with the same jobs, not an inverted light set, so every semantic token keeps its role across themes.

## Addendum (2026-10-28) — the dark-mode elevation ladder

Source: material-3, apple-hig, carbon

In a dark theme, nearer surfaces get lighter, not darker and not shadowed:

| Level | Use | Role |
|---|---|---|
| 0 | App background | `bg.app` (darkest; avoid pure black for large areas) |
| 1 | Page sections, cards | `bg.surface` |
| 2 | Navigation, sidebars, sticky bars | `bg.surface-raised` |
| 3 | Menus, popovers, sheets | `bg.overlay` |
| 4 | Dialogs above a scrim | `bg.modal` + scrim |

Step each level by a small, even lightness increase; text and border contrast is rechecked on the lightest level. Material 3 expresses the same ladder as surface-container roles from lowest to highest; Apple uses base and elevated backgrounds; Carbon alternates layer tokens so that a nested layer always contrasts with its parent. Shadows only separate surfaces that overlap; in a light theme they may carry the ladder instead.

## Source conflicts

- **Claim:** How a dark theme shows depth
  **Sources:** material-3, apple-hig, carbon
  **Default:** Lighter tonal surfaces for nearer layers, shadows only for overlap, on every platform; on iOS map the ladder onto the system base and elevated backgrounds.
  **Reason:** Shadows barely show on dark backgrounds; all three systems agree on lighter-is-nearer and differ only in naming, so one ladder with per-platform names serves all.
  **Platform scope:** web, telegram-mini-app, ios, android
- **Claim:** Telegram Mini App colours versus the app's own token ladder
  **Sources:** telegram-webapps, radix-colors
  **Default:** In a Mini App, semantic tokens alias `themeParams` (`bg.app` → `bg_color`, `bg.surface` → `secondary_bg_color` or `section_bg_color`, `accent.solid` → `button_color`); the app's own scale fills only roles Telegram does not provide.
  **Reason:** The host theme changes at run time and users expect the Mini App to match the client; a fixed scale breaks in the other theme.
  **Platform scope:** telegram-mini-app
