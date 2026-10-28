---
name: aura-uiux
origin: aura
description: Sourced platform rules for UI work on Telegram Mini Apps, iOS and Android screens, plus an audit method (Nielsen heuristic, 0–4 severity, evidence, fix) and a semantic-token / dark-mode elevation ladder. Use when building or reviewing a Mini App or native mobile screen, when an audit or critique needs a severity scale, or when setting up colour tokens. Loads only the reference the task needs.
---

# Aura UI/UX addenda

## When this applies

Use this skill alongside the design skills (audit, critique, polish, adapt, ui-ux-pro-max, taste-skill) when the target is not a plain desktop web page, or when findings need a shared scale. It adds platform rules and method; it does not replace those skills.

## Addendum (2026-10-28) — route: read one platform file, then at most one method file

Source: aura

| The task targets | Read |
|---|---|
| A Telegram Mini App (`telegram-web-app.js`, `@telegram-apps/*`, `Telegram.WebApp`) | `references/telegram-mini-app.md` |
| An iOS / iPadOS screen (SwiftUI, UIKit, or a web view shipped as an iOS app) | `references/ios.md` |
| An Android screen (Compose, Views, or a web view shipped as an Android app) | `references/android.md` |
| An audit, critique or usability test that must rank findings | `references/evaluation-method.md` |
| Colour, surface or elevation tokens, or a dark theme | `references/token-ladder.md` |

A plain web page or SPA needs no platform file: the web defaults in the design skills apply. A Mini App runs inside Telegram on a phone, so read `telegram-mini-app.md` and treat touch-target and back-navigation rules from the host OS file as the floor.

## Addendum (2026-10-28) — word budget

Source: aura

This file stays under 400 words. Each reference file stays under 900 words and opens with "When this applies", so a session reads one platform file (about 700 words) and at most one method file, never the whole folder.

## Addendum (2026-10-28) — how the references are built

Source: aura

Every rule in `references/` is a paraphrase with its source named in a `Source:` line; catalog ids resolve in Aura's `docs/research/uiux-sources/CATALOG.md`. No passage is copied verbatim. Where two sources disagree, the file's `Source conflicts` block states the claim, the sources, the default chosen, the reason and the platforms it covers.

## Source conflicts

None between the sources used here.
