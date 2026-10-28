# saarinen — semantic tokens and the dark elevation ladder

Platform: all

## When this applies

A change adds or edits colour, surface or elevation tokens, adds a dark theme, or puts raw hex values in components.

## Addendum (2026-10-28) — tiers, steps and the ladder

Source: design-tokens-format, radix-colors, material-3, apple-hig, carbon

- **Three tiers.** Primitives (`gray.50`) are read only by semantic tokens (`bg.surface`, `text.muted`, `accent.solid`), which components read; a component reading a primitive or a raw hex is **P2**. Each background role has a paired foreground role.
- **A job per step.** A twelve-step scale gives steps 1–2 to backgrounds, 3–5 to component fills at rest, hover and selected, 6–8 to borders and focus rings, 9–10 to solid fills, 11–12 to text. The dark scale is its own set with the same jobs, not an inversion.
- **Nearer is lighter in dark themes.** App background, then surface, raised surface (navigation), overlay (menus, sheets), modal over a scrim, each a small even lightness step; shadows only where surfaces overlap. Material 3 names these surface-container roles, Apple base and elevated backgrounds, Carbon alternating layers.

## Source conflicts

- **Claim:** How a dark theme shows depth
  **Sources:** material-3, apple-hig, carbon
  **Default:** Lighter tonal surfaces for nearer layers and shadows only for overlap, mapped to each platform's own role names.
  **Reason:** Shadows barely show on dark grounds, and the three systems agree on lighter-is-nearer while naming it differently.
  **Platform scope:** web, telegram-mini-app, ios, android
