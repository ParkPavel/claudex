# Hand work over when a provider runs out

A provider can stop answering in the middle of a task: a quota ends, an account loses access,
an executable disappears. The harness does not guess what to do about it. Either the remaining
provider takes the absent one's roles through an act you recorded, or the absent provider's
roles stop working and say why.

Open the window from the workspace desktop:

```bash
node claudex/bin/claudex.mjs modes
```

In a terminal that can answer, this draws one frame: the mode, each provider's availability,
the open delegations and the re-check debt, followed by the acts available. Outside a terminal
— a script, a hook, a log — the same frame prints once and the command exits, so nothing
blocks on a prompt.

## The acts

| Act | Flag | What it records |
|---|---|---|
| Delegate | `modes --delegate codex>claude --reason "…"` | `codex` is unavailable and `claude` answers for its roles |
| Mark unavailable | `modes --unavailable codex --reason "…"` | `codex` is unavailable and nobody substitutes; its roles refuse to run |
| Restore | `modes --restore codex [--note "…"]` | `codex` is back and owns its roles again |
| Settle | `modes --settle <delegation-id> --evidence <ref[,ref]>` | the owed re-check has been run, with evidence |
| Read | `modes --status`, `modes --debt`, `--json` | the state, for a person or a script |

`--roles a,b` narrows a delegation to named roles instead of every role the absent provider
owns. A reason shorter than a sentence is refused: the record exists for a reader who arrives
later without this conversation.

## What a delegation does not do

- **It does not widen authority.** A role that needs `workspace-write` cannot move to a
  read-only provider, and the check happens before a job is queued rather than inside the
  adapter.
- **It does not chain.** A provider that is itself unavailable cannot be someone's substitute,
  because a chain hides who actually answered.
- **It does not happen on a model's initiative.** A model cannot open one; an uncovered
  unavailable provider fails the job with an instruction addressed to you.
- **It does not turn one family's second opinion into independent review.** Every job produced
  under a delegation is stamped `independence: SINGLE_MODEL`, `recheck: OWED`, and carries the
  delegation on the job record. The substitute is told in its prompt that it is standing in.

## The debt

`modes --debt` lists every job that a substitute answered and that still owes a re-check:

```json
[
  {
    "delegation": "delegation-…",
    "answeredBy": "claude",
    "insteadOf": "codex",
    "state": "CLOSED",
    "jobs": [{ "jobId": "…", "taskId": "…", "role": "auditor", "proposedAcceptance": "PASS" }]
  }
]
```

Restoring the provider closes the delegation but keeps the debt: the roles come back, the
verdicts do not become independent retroactively. Re-run the owed work with the restored
provider, then `--settle` it with the artifact references that prove the re-check ran. A
delegation under which nothing ran closes as `recheck: NONE` — there is nothing to re-check,
and recording a permanent debt for it would be noise.

A job queued under one arrangement and started under another fails instead of running: the
answer would carry a provenance nobody agreed to. Resubmit it under the current arrangement.

## Where the state lives

`.local/claudex/delegation.json`, next to the other local state, never in a public repository.
It holds the providers' availability, the open delegations and the closed history with each
debt's condition. The shared contract carries the rule these commands enforce; see
[core.md](../../config/core.md).
