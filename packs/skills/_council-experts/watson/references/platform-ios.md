# watson — iOS accessibility

Platform: ios

## When this applies

The screen ships as an iOS or iPadOS app. VoiceOver, Dynamic Type, Voice Control and the display settings are the assistive layer to test against.

## Addendum (2026-10-28) — Dynamic Type, targets, contrast settings

Source: apple-hig, wcag-22

- **Dynamic Type at the largest sizes.** Text uses scalable styles and is checked at the accessibility sizes: no truncation of essential text, rows grow, horizontal layouts stack. Fixed-size text in primary content is **P1**.
- **44×44 pt targets** for primary controls, with spacing; smaller only for secondary controls.
- **Contrast.** At least 4.5:1 for text up to 17 pt and 3:1 for larger or bold text, in light and dark; aim for 7:1 for small custom text. Honour Increase Contrast with higher-contrast variants.
- **Every gesture has a control.** Swipe-only actions fail switch-access and Voice Control users (**P1**).
- **Reduce Motion** replaces zoom, scale and parallax with fades.
- **VoiceOver** labels name the purpose, not the glyph; grouped elements read as one.

## Source conflicts

None between the sources used here.
