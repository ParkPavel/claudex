---
name: task-contract
description: Define a bounded delegation packet when work is handed to another agent or resumed after interruption. Use for task scope, accepted decisions, source state and acceptance criteria; skip ordinary single-step answers.
---

# Task contract

State the objective and the observable result. Identify the project, task ID, relevant paths,
accepted decisions, explicit exclusions and authority. Use `snapshot` when no change is being
reviewed; use `diff` with a pinned base for a change review. Do not require a nonempty diff for
mapping or design.

Give each criterion a stable ID. Separate what is known from what must be established. Refer
to current evidence instead of passing the entire conversation. Preserve contradictions and
unresolved conditions. A reviewer needs facts without an expected conclusion.

One coordinator owns the journal. Resume by task ID, job ID and source digest. Cancel and
confirm termination before replacing a worker. Missing readiness is not progress.

Method and limits: [evidence register](../../docs/research/evidence-register.md).
