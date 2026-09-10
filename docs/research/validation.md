# Validation and release evidence

Published observations: [0.1.0 integration record](release-0.1.0.md).

## Executable checks

Run `npm run verify` in the repository. The package uses Node's built-in test runner and
does not call paid model APIs during tests. Fixtures create temporary Git repositories and
real child processes; credential-shaped test values are constructed locally and never
printed. Tests exercise both success and failure behavior.

The suite covers workspace discovery, edited entrypoint refusal, path/junction escape,
dirty/untracked snapshot changes, role escalation, empty-diff mapping, model/effort flags,
criterion identity, worktree bootstrap, process readiness, timeouts, cancellation, duplicate
tasks/workers, stale evidence and preservation of UNKNOWN acceptance. Publication cases
include staged-versus-working-tree content, secrets deleted from later history, redacted
diagnostics, protected refs, deletion and non-fast-forward pushes.

These tests establish contracts against fixtures. They do not prove that a future provider
release enforces the same sandbox, that an Obsidian flow works, or that a skill improves
real tasks. Provider and live-host smoke results belong in release evidence.

## Release checks

1. Run static/link checks and the full local test suite.
2. Scan staged blobs and all reachable Git history. Inspect the exact publication tree.
3. Verify actual provider versions, readiness and structured output on a bounded read-only task.
4. For Obsidian, verify native CLI, explicit vault identity and one reversible test-vault
   write/readback plus developer inspection. Record remaining unavailable capabilities.
5. Review migration inventory, backup verification and retired entrypoints.
6. Publish through guarded Git operations and verify GitHub branch protection/status checks.

## Comparative evaluation

Use a repaired minimal harness as control. Add one skill/tool/model allocation at a time.
Hold initial repository state, objective, criteria and available tools constant. Alternate
run order and report variation; three pilot repetitions are exploratory, not statistical
proof. Blind the evaluator to the configuration label when possible.

Measure verified completion, false PASS, confirmed finding precision, seeded defect recall,
introduced regressions, lost handoff conditions, human interruptions, time to acceptance and
total provider usage including retries, cache and indexing. Keep model cost separate from
subscription limits. Do not select a token-saving configuration that increases false PASS.

Include negative triggers: simple edits should not load a large process; source instructions
must not override the task; old graph facts must not outrank current files; a convincing
author explanation must not substitute for independent verification.

## Current limits

No comparative Claudex-versus-other-harness benchmark has been completed. Automatic orphan
takeover, arbitrary provider/tool plugins, a semantic code index and automatic publication
are not included in 0.1.0. These require a separate contract and evidence before release.
