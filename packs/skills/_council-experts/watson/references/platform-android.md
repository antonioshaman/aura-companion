# watson — Android accessibility

Platform: android

## When this applies

The screen ships as an Android app. TalkBack, font scaling, switch access and the remove-animations setting are the assistive layer to test against.

## Addendum (2026-10-28) — targets, font scale, contrast settings

Source: material-3, wcag-22

- **48×48 dp targets** for every touch target, including icon buttons whose glyph is 24 dp; overlapping targets are **P1** when they trigger different actions.
- **Font scale.** Text in `sp` and layouts checked at the largest font scale: nothing clipped, containers grow. Fixed `dp` text is **P1**.
- **Roles keep contrast.** Text uses the on-colour of its container role, checked in light, dark and any dynamic-colour scheme.
- **Content descriptions** on every meaningful icon; decorative images marked as such.
- **High-contrast text and remove-animations** settings are honoured; motion never carries the only signal.
- On the web, the forced-colours equivalent is Windows High Contrast: custom controls keep visible borders and focus under `forced-colors: active`.

## Source conflicts

None between the sources used here.
