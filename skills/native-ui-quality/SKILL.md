---
name: native-ui-quality
description: Hold an interface to the iOS quality bar — touch targets, safe areas, sheets, typography, direct and interruptible motion, no hover dependence — using the local reference library of Apple HIG and design-engineering skills. Use when designing, building or reviewing UI that must feel native on a phone or tablet, including web views such as Obsidian mobile; skip server code and copy-only edits.
---

# Native UI quality

The bar is how a well-made iOS app behaves: it answers a touch at once, follows the finger,
can be interrupted, puts things where the hand expects them and never makes a person aim.
That bar is public, specific and understood by everyone who owns a phone, which is why it
is the reference even for interfaces that also run on the desktop.

The detail lives in `library/` of the harness (`claudex/library/README.md`). Read only the
files the task needs, cite the file you took a rule from, and check every value against the
current platform before it becomes a decision. The library informs; the project's own design
system, the contract and the recorded principles decide.

## The bar, in order of what people notice first

1. **Response.** Feedback on pointer-down, not on release; no tap delay. A control that waits
   for a network round trip shows its pressed state first.
2. **Targets.** Minimum hit region 44×44 pt on iOS and iPadOS (`apple-hig/distilled/buttons.md`,
   `accessibility.md`). A small glyph gets a larger invisible hit area, not a larger glyph.
3. **Reach and placement.** Primary actions sit where a thumb reaches; destructive ones are
   separated and confirmed. Secondary tasks open as a sheet over the context they came from
   (`sheets.md`, `action-sheets.md`).
4. **Safe areas.** Nothing interactive under the notch, the home indicator or the on-screen
   keyboard (`layout.md`; `emil/mobile-native` §7).
5. **No hover dependence.** Anything revealed on hover has a touch path; hover styling is
   gated by `(hover: hover) and (pointer: fine)` (`emil/mobile-native` §1). Touch and mouse
   coexist on one device: gate by capability, never by device.
6. **Text.** Readable sizes that follow the platform scale; inputs at 16px or more so the page
   does not zoom (`typography.md`; `emil/mobile-native` §4).
7. **Motion.** Direct manipulation tracks 1:1, animations are interruptible and hand velocity
   to the next state, paths are spatially consistent, and reduced motion is honoured
   (`emil/apple-design` §2–7 and §14; `apple-hig/distilled/motion.md`). Motion that only
   decorates is removed, not tuned.
8. **Appearance.** Dark mode and increased contrast are designed, not inverted (`dark-mode.md`,
   `color.md`).

## Where to read, by task

| Task | Read |
|---|---|
| Web UI that feels wrong on a phone | `emil/mobile-native/SKILL.md` (symptom table first) |
| Any iOS/iPadOS layout or component | `apple-hig/routing-index.md` → tier 1 + `designing-for-ios` or `designing-for-ipados` + matched component files |
| Gestures, drag, swipe, sheets, springs | `emil/apple-design/SKILL.md`, `apple-hig/distilled/gestures.md` |
| Building a new animation | `emil/animate/SKILL.md`, then `RECIPES.md` |
| Reviewing motion in a diff | `emil/review-animations/SKILL.md` and `STANDARDS.md` |
| Auditing a whole codebase's motion | `emil/improve-animations/SKILL.md`, `AUDIT.md` |
| Naming an effect precisely | `emil/animation-vocabulary/SKILL.md` |
| General polish and component craft | `emil/emil-design-eng/SKILL.md` |
| Swift code | `emil/write-swift/SKILL.md` |
| React Native / Expo motion | `emil/animate-expo/SKILL.md` |

## Obsidian as the host

Obsidian's mobile apps run the same plugin code in a web view, so the web-on-phone fixes
apply directly, and the app's own chrome is the native context a plugin sits in.

- Branch on capability first (media queries, `env()`), then on the host's own flags:
  `Platform.isMobile`, `isPhone`, `isTablet`, `isIosApp`, `isAndroidApp`, `isMobileApp` from
  the `obsidian` module. Confirm them in the installed `obsidian.d.ts` before relying on one.
- Use the app's CSS variables and components for colour, spacing and type so the plugin
  follows the theme; a hard-coded value is a defect on some theme.
- The host already owns parts of the screen (navigation, drawers, the keyboard toolbar).
  Check what it pads or captures before adding safe-area padding or a gesture of your own;
  double padding and stolen swipes are the common failures.
- Desktop emulation of mobile is a layout check only. Hover, tap delay, rubber-banding, safe
  areas and the keyboard need a device (`emil/mobile-native`, hard rule 5); record which one
  was used. Live evidence follows `obsidian-acceptance`.

## Reporting

A review lists findings, each with location (`file:line`), what a person experiences, the rule
and the library file it comes from, and the smallest change that meets it. Rank by what people
notice first (the order above). State what was not observed on a device as UNKNOWN; a
screenshot at phone width does not show touch behaviour.
