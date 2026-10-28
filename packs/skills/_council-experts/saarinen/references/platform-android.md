# saarinen — Android visual craft

Platform: android

## When this applies

The screen ships as an Android app. Material 3's colour roles and tonal elevation are the visual system to inherit.

## Addendum (2026-10-28) — tonal elevation and colour roles

Source: material-3, material-components-android

- **Depth by tone.** The body uses `surface`; nested regions (navigation, cards, menus) use the five surface-container roles from lowest to highest. Shadows appear only where surfaces overlap. Elevation drawn with shadows on every card is **P3**.
- **Roles in pairs.** Each container colour is paired with its on-colour; text in the wrong role (for example `on-primary` on `surface`) is **P2** for contrast and consistency.
- **Same roles across widths.** A region keeps its role from compact to expanded; larger windows add container levels, they do not recolour regions.
- **Motion tokens.** Durations and springs come from the motion scheme's tokens, not hand-picked values.

## Source conflicts

None between the sources used here.
