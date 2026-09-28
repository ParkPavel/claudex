---
name: systematic-diagnosis
description: Investigate a regression, failed check or unexpected behavior before changing implementation. Use to distinguish the observed symptom from its cause; skip cosmetic edits without a behavioral defect.
---

# Systematic diagnosis

Record expected and observed behavior at the real interface. Reproduce the failure or state
why reproduction is unavailable. Read the actual event, transform and persistence path.
Form one falsifiable explanation and select a check that can disprove it.

For a behavioral regression, add or use a test that fails through the relevant boundary.
A red test proves the fix only if it fails for the reason the fix removes: read the failure
message of every failing suite, not one representative. A TypeError in the test's own setup
fails under any implementation and proves nothing. Change one coherent cause, run the check,
then the applicable project checks, including the type checker and linter for code changes;
a passing test run does not show the code compiles under strict settings. A test that merely
duplicates implementation is not evidence. Existing authorization is sufficient for the
accepted task; do not restart approval rituals.

Close a bug in three separate steps: assess (the cause, with the evidence that rules out the
alternatives), fix (the smallest change to that cause), and re-test the original symptom at
the interface where it was reported. A new unit test passing is not the symptom gone.

Rule out the environment before blaming a commit. A missing tool ("eslint is not recognized"),
an emptied shared dependency folder, a line-ending or path-translation difference makes a
healthy tree look broken; check the install and the platform first when a failure appears
without a change that could cause it.

If two consecutive fixes create new defects, stop patching and reconsider ownership, state
representation and assumptions. Record remaining unknowns and the next discriminating check.
