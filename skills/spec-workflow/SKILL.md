---
name: spec-workflow
description: Bind a feature, behavioral fix or multi-file maintenance task to scoped implementation and current verification evidence. Use before implementation and at convergence; skip ordinary questions, source-only reviews and trivial cosmetic edits.
---

# Specification workflow

Keep one local contract at `.local/claudex/tasks/<id>/contract.json`. Use the workspace's
Claudex entrypoint: `task init <id> --goal <text> --kind feature|bug|maintenance`, adding
`--worktree <workspace-relative-path>` for implementation. Existing authorization applies;
record accepted decisions without asking again. A draft is deliberately not ready.

Fill the observable goal, nonGoals, decisions, bounded paths, criteria, tasks and checks.
Criteria have stable IDs, text and required evidence kinds: automated, source, ui,
persistence or review. Tasks map to criteria and declare dependencies; checks declare a
command, argument array and criterion IDs. Expand into a separate design or plan only when
the decisions need it. Run `task check <id>` before implementation or delegation.

For writing jobs, set `contractId` to that task ID, bind the same worktree, use a subset of
its paths and criterion IDs. Job taskId identifies a particular bounded assignment, not
necessarily the whole contract. The local `workflow.requireContract` setting enforces this
at submission and worker startup. Use existing Claudex worktrees, claims and approvals.

For a regression, record the observed and intended behavior, reproduce the symptom and run
a meaningful failing test before the fix. `task verify <id> --check <id>` retains the failure
and later passing check. Documentation and cosmetic work need proportional validation.
All declared checks for a criterion must pass; a pass on one check cannot cover another.

Use `task record <id> --params <json>` for an observation with criterionId, kind, status,
artifact, note, observer, sourceDigest, configurationDigest and contractDigest. The artifact must already
exist under the workspace's `.local/claudex/artifacts`. Supply the digests of the state
actually observed, including its specification; do not stamp an old screenshot with today's state. This records an
attestation, not automatic validation. A review needs a separate reviewer job and artifact;
changing the observer label cannot make self-review independent. For live Obsidian work,
also bind the deployed bundle and persisted readback using obsidian-acceptance.

Run `task converge <id>` after changes and review. Inspect PASS, FAIL or UNKNOWN per criterion,
scope violations and artifact provenance. Missing, altered or stale evidence cannot pass.
Changing the specification or configuration requires re-verification. A report evaluates
the selected criteria; it does not authorize publication or prove requirements were complete.
Keep unresolved criteria and next checks in the task journal. Finish worktrees through Claudex.

Keep delegation economical: bounded routine docs or mapping on an available cheaper model,
normal implementation on the configured workhorse, stronger models for difficult decisions
or reviews. Pass only relevant source/evidence and poll `status --summary`. On a provider
failure, inspect its record before retrying. A time window does not specify token allowance.

An optional Graphify index may suggest relevant files. Pin its source snapshot; distinguish
EXTRACTED from INFERRED links and confirm them in source. Missing edges never prove missing
behavior. Keep the initial index local and code-only; vault content and private evidence
are excluded. An index neither grants authority nor substitutes for tests or live checks.

For complete fields and examples, read `docs/how-to/spec-workflow.md` in the harness only
when preparing a contract or observation for the first time.
