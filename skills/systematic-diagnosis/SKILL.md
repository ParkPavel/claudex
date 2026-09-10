---
name: systematic-diagnosis
description: Investigate a regression, failed check or unexpected behavior before changing implementation. Use to distinguish the observed symptom from its cause; skip cosmetic edits without a behavioral defect.
---

# Systematic diagnosis

Record expected and observed behavior at the real interface. Reproduce the failure or state
why reproduction is unavailable. Read the actual event, transform and persistence path.
Form one falsifiable explanation and select a check that can disprove it.

For a behavioral regression, add or use a test that fails through the relevant boundary.
Change one coherent cause, run the check, then the applicable project checks. A test that
merely duplicates implementation is not evidence. Existing authorization is sufficient for
the accepted task; do not restart approval rituals.

If two consecutive fixes create new defects, stop patching and reconsider ownership, state
representation and assumptions. Record remaining unknowns and the next discriminating check.

Method and limits: [evidence register](../../docs/research/evidence-register.md).
