---
name: flow-render
description: Trace one user action from visible promise to actual state and persistent effect using current source. Use for user-visible changes and flow review; code-derived hypotheses do not replace live acceptance.
---

# Flow render

Trace one complete action across component, handler, store, API and persistence boundaries.
For each gap, supply two independent references: the visible promise, with the resolved user
string, and the actual effect. A translation key alone is not the string. A single proof
belongs in UNKNOWN.

Return SCOPE, SCREEN, EVIDENCE, STATE, EFFECT, GAP and UNKNOWN. Include empty, loading, disabled,
failure and recovery states. Pin the source snapshot and describe exclusions.

This pass cannot establish real geometry, keyboard behavior, race timing, host failures,
caches or whether a theoretical path executes. Use Obsidian acceptance for those claims.
Read only; send results to the coordinator rather than writing its journal.

Origin: the maintainer's OBS flow review practice, refined after local persistence defects.
Its effectiveness across other projects has not been benchmarked.
