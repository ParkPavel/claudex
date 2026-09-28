---
name: evidence-gate
description: Assess a completion, review or acceptance claim against current evidence. Use before declaring work complete or recommending integration; skip exploratory hypotheses that make no completion claim.
---

# Evidence gate

For each acceptance criterion, return PASS, FAIL or UNKNOWN with a source or command artifact.
Do not equate process completion with success. Check the code and configuration digests that
the evidence describes. Fixes invalidate review of the affected earlier state.

Separate static source evidence, automated execution, visible UI and persisted state. A
screenshot establishes appearance; a successful response establishes transport; persistence
requires readback at the intended boundary. Bind deployed bundle and tested app state when
the claim concerns the running product.

A reviewer bound to a task contract receives the coordinator's check runs. Use a CURRENT run
as the automated evidence for its criteria; a STALE one describes another snapshot. A check
that cannot run in a read-only sandbox (EPERM, missing network) is UNKNOWN from that sandbox,
not FAIL, and does not override a CURRENT run. A job that answered only some criteria records
the rest as UNKNOWN with the reason; read `resultGaps` before treating its verdict as whole.

Verify reported findings against source before accepting them. Record rejected findings with
reasons. Read canonical budgets at their source rather than copying numbers into instructions.
Evidence files remain local. A model's proposed PASS still needs independent adjudication.

For a task with a spec-workflow contract, run task converge and inspect every required
evidence kind. Missing, stale or altered artifacts cannot pass. Manual source, UI, persistence
and review records are explicit attestations, even when their hashes are valid. Verify review
provenance separately; naming an observer does not establish independence. Convergence does
not authorize publication or retirement of unrelated worktrees.
