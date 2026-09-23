# Local specification and verification

This workflow adapts the intent/plan/tasks/convergence sequence from
[Spec Kit](https://github.com/github/spec-kit), regression-first work and separated review
from [Superpowers](https://github.com/obra/superpowers), and source provenance and navigation
from [Graphify](https://github.com/Graphify-Labs/graphify). It adds no dependency on those tools.
Claudex remains the job, authority and worktree owner. Graphify is optional and not installed
or hooked into source reads by this change.

## Contract

Create a worktree through Claudex, then initialize the task:

```text
node claudex/bin/claudex.mjs worktree example-fix
node claudex/bin/claudex.mjs task init example-fix --kind bug --goal "Retain the selected item after refresh" --worktree .local/claudex/worktrees/example-fix
```

Edit `.local/claudex/tasks/example-fix/contract.json`. Preserve the generated identity,
worktree and base snapshot. Initialization also saves `basis.json`; editing the contract's
identity, worktree or base will fail validation. Create a new task to select another baseline.
Fill these fields (the values below illustrate a project with
an app module and a Node test; choose paths and commands that actually exist in your project):

```json
{
  "paths": ["src/selection.mjs", "test/selection.test.mjs"],
  "nonGoals": ["Do not change storage format"],
  "decisions": ["Expected: refresh retains selection. Observed: refresh clears it."],
  "criteria": [
    {"id": "selection", "text": "Refreshing retains the selected item", "requires": ["automated", "review"]}
  ],
  "tasks": [
    {"id": "regression", "text": "Reproduce loss of selection", "criteria": ["selection"], "dependsOn": []},
    {"id": "fix", "text": "Correct state ownership", "criteria": ["selection"], "dependsOn": ["regression"]}
  ],
  "checks": [
    {"id": "selection-test", "criteria": ["selection"], "command": "node", "args": ["--test", "test/selection.test.mjs"], "timeoutMs": 120000}
  ]
}
```

The complete contract also contains `schemaVersion: 1`, `taskId`, `kind`, `goal`,
`base: {head,digest,fileCount}`, and `worktree` (null for the primary checkout). Valid kinds
are feature, bug and maintenance. Paths are literal repository-relative files/directories,
not globs or the repository root. Every criterion needs task coverage and required evidence
kinds. Every automated criterion needs check coverage. IDs are unique, mappings must resolve,
and task dependencies must be acyclic. Check timeouts are at most 900000 ms.

`task check example-fix` validates structure, worktree ownership and baseline ancestry.
It cannot decide whether the requirement is useful or the chosen test proves it.

Writing provider packets may refer to the contract with `contractId: "example-fix"`.
Their worktree must match, and paths/criterion IDs must be subsets of the contract. With
`"workflow": {"requireContract": true}` in local workspace.json, unbound writers are refused
before queuing. Existing installations default to legacy compatibility when this setting
is absent. A queued job rejects a changed contract at startup. Native direct edits remain
governed by the skills and coordinator; this is not an operating-system sandbox.

## Verification

```text
node claudex/bin/claudex.mjs task verify example-fix --check selection-test
node claudex/bin/claudex.mjs task converge example-fix
```

Verification uses the declared command and args directly, stores stdout/stderr locally, and
binds them to before/after source, runtime configuration and specification digests. A command
failure is retained. A source/configuration change during execution makes its evidence stale.
Do not use verify for deployment or another mutation that changes the snapshot being tested.
A check that must mutate files, such as a build that rewrites a tracked bundle, sets
`"isolate": true`: it runs in a disposable copy of every tracked and non-ignored file as it
is on disk, with `node_modules` linked in, so the checkout and its evidence stay current. Add
`"reproduces": [{"output": "main.js", "against": ["main.js", "@workspace/<vault>/.obsidian/plugins/<id>/main.js"]}]`
to compare the fresh output with the tracked file and a deployed copy; each pair reports
MATCH, DIFFER or MISSING and anything but MATCH fails the check. `"eol": "ignore"` compares
text after dropping CR, for checkouts that convert line endings; such a match is marked
`normalized` and is not a byte match.
Source snapshots cover tracked and non-ignored Git files; ignored bundles need separate hashes.

Record real source/UI/persistence/review observations with `task record <id> --params <json>`.
An observation has this shape:

```json
{
  "criterionId": "selection",
  "kind": "review",
  "status": "PASS",
  "artifact": ".local/claudex/artifacts/review-job/result.json",
  "note": "Reviewer checked this criterion against the final diff and tests",
  "observer": "review-job-id",
  "sourceDigest": "the actual observed source digest",
  "configurationDigest": "the actual observed runtime digest",
  "contractDigest": "the actual observed specification digest"
}
```

Obtain the digests from current verification evidence or a convergence report, and check that
the observation actually belongs to them. The artifact must already exist, be nonempty and
remain inside the local artifact directory after resolving links. The CLI records a hash and
an explicit attestation. It does not validate the meaning of a screenshot, the observer's
identity, or review independence. No caller can record kind `automated`; use verify for that.
For live checks use the Obsidian acceptance workflow to bind app state, deployed bundle and
readback. A unit-test pass does not satisfy UI or persistence kinds.

Convergence selects the latest evidence separately for every required kind and every mapped
automated check. An older pass cannot hide a newer failure, unknown, stale or altered artifact.
Changes outside the task's scope fail convergence; in-scope uncommitted work is allowed. Only
untracked root AGENTS.md and CLAUDE.md harness pointers are excluded from the scope check.
The result is PASS, FAIL or UNKNOWN; missing required evidence remains UNKNOWN.

Legacy provider jobs still keep `acceptance: UNKNOWN` with a model-proposed verdict.
Task convergence is a separate report; it neither changes job acceptance nor merges a branch.
Store local contracts, logs and reports outside published source. When preparing a PR, write
a scrubbed requirement/decision summary in the project's normal documentation if needed.

## Model and context economy

Use bounded routine work on a cheaper available model; Haiku and Sonnet are configured Claude
options, and packet `model`/`effort` can override the provider-role defaults. The adapter's
provider and authority restrictions still apply. Reserve stronger models for ambiguity,
state ownership and high-risk reviews. Escalate after a concrete inadequate result, not by
dispatching every available role. Poll `status --summary` to avoid reloading packets and
transcripts. Jobs retain provider-reported usage when supplied; no cross-provider token quota
or account billing calculation is implied. A five-hour window is not a numerical token limit.

An optional Graphify pilot should index a pinned code snapshot locally, excluding vaults,
credentials, sessions, build outputs and private evidence. Confirm EXTRACTED/INFERRED links
in source. Its graph is a navigation aid; no edge and no search hit are not behavior proofs.
Measure its usefulness on an actual mapping task before adding dependencies or hooks.
