# watson — iOS accessibility

Platform: ios

## When this applies

The screen ships as an iOS or iPadOS app. VoiceOver, Dynamic Type, Voice Control and the display settings are the assistive layer to test against.

## Addendum (2026-10-28) — Dynamic Type, targets, contrast settings

Source: apple-hig, wcag-22

- **Dynamic Type at the largest sizes.** Text uses scalable styles and is checked at the accessibility sizes: no truncation of essential text, rows grow, horizontal layouts stack. Fixed-size text in primary content is **P1**.
- **44×44 pt targets** for primary controls, with spacing; smaller only for secondary controls.
- **Contrast.** At least 4.5:1 for body text; 3:1 only for large text, meaning 18 pt regular or 14 pt bold and up. Check light and dark, aim for 7:1 for small custom text, and honour Increase Contrast with higher-contrast variants.
- **Every gesture has a control.** Swipe-only actions fail switch-access and Voice Control users (**P1**).
- **Reduce Motion** replaces zoom, scale and parallax with fades.
- **VoiceOver** labels name the purpose, not the glyph; grouped elements read as one.

## Source conflicts

- **Claim:** Contrast threshold for bold text
  **Sources:** apple-hig, wcag-22
  **Default:** 3:1 only for 18 pt regular or 14 pt bold and larger; every other text, bold or not, needs 4.5:1.
  **Reason:** HIG's table allows 3:1 for bold text at any size, but WCAG counts bold as large text only from 14 pt; the stricter rule keeps small bold labels legible and passes both.
  **Platform scope:** ios
