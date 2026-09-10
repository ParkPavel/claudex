---
name: obsidian-acceptance
description: Plan and assess live Obsidian plugin checks using the native CLI and an explicitly selected test vault. Use for rendering, plugin reload, observed behavior and persistence; skip source-only reviews.
---

# Obsidian acceptance

Use the Claudex Obsidian adapter. It verifies the selected vault path, captures local evidence
and requires an explicit test-vault designation for mutations. Never rely on the active vault.
Check CLI capability first. A missing CLI is a failed prerequisite, not a passing test.

Bind the code/build to the run. Capture relevant DOM, errors and appearance. Perform the
target action and read back the resulting state. For persistence, reload and read again.
Inspect empty, error and recovery paths that belong to the criterion.

Developer JavaScript can mutate data: explicit `eval` is treated as a mutation even when its
author calls it a read. Arbitrary model-generated evaluations are not a read-only tool.
Do not use production vaults for automated mutations or put their contents in public reports.

Return artifact paths, criterion outcomes and limitations. See the [CLI guide](../../docs/how-to/obsidian.md).
