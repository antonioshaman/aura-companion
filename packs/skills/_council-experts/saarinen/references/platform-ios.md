# saarinen — iOS visual craft

Platform: ios

## When this applies

The screen ships as an iOS or iPadOS app. Visual decisions should read as native: system materials, system type and the base/elevated colour model.

## Addendum (2026-10-28) — native surfaces and type

Source: apple-hig

- **System colours first.** Background and label colours come from the system's semantic colours so dark mode, Increase Contrast and tinting work. In dark mode, layered surfaces (sheets, popovers) use the brighter elevated backgrounds over dimmer base ones. Custom hex backgrounds that ignore this are **P2**.
- **Materials for controls, not content.** The current Liquid Glass material belongs to bars and controls floating above content; putting it on content cards muddies the hierarchy (**P3**).
- **Type scales.** Use the system text styles so Dynamic Type works; hierarchy comes from style and weight, not ad-hoc point sizes. Thin weights at small sizes are **P3**.
- **Full-width primary buttons** for the main action of a screen; secondary actions stay quieter.

## Source conflicts

None between the sources used here.
