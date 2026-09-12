# Commands and task contracts

Project check arguments may contain `{artifactDirectory}`; the runner replaces it with that
run's private output directory as one argument. The Obsidian profile writes its Jest JSON
report there, alongside command logs and the source-bound check record.

Run `node claudex/bin/claudex.mjs help` from the workspace desktop. When outside it, pass
`--workspace <desktop>`. The working directory is resolved to the managed Git root rather
than inferred from the currently focused application.

| Command | Result |
|---|---|
| `setup [--workspace …]` | Open the installation window and write the configuration it collects |
| `init --workspace … --project … [--access …]` | The same decisions as flags, for a script that cannot answer prompts |
| `settings [--show] [--access …] [--assign …]` | Read or change the access mode and the per-role assignments |
| `sync` | Update generated files only when their previous hashes match; write down a migrated configuration |
| `doctor` | Check entrypoints, prerequisites, providers, worktrees, scope claims, delegations, approvals and orphan jobs |
| `worktree TASK --base REF [--paths a,b]` | Create a dedicated branch/worktree, and claim the scope it will work on |
| `worktree --retire PATH [--force --reason …]` | Retire a finished worktree without taking a shared install with it |
| `claims [--release ID]` | Show the declared work scopes, or release one |
| `approve TASK --reason …` | Issue a one-shot approval for one writing task |
| `run PACKET [--wait]` | Submit a task; background by default, exact job ID returned |
| `status [JOB]` | Read all job records or one exact job |
| `cancel JOB` | Request cancellation; terminal state follows confirmed closure |
| `obsidian OP --params JSON [--write]` | Execute a scoped host operation and save evidence |
| `check-project` | Execute the selected profile's commands in the managed project |
| `modes [--status\|--debt\|--json]` | Show who answers for which roles and what re-check is owed |
| `modes --delegate A:B --reason …` | Record that A is unavailable and B answers for its roles |
| `modes --unavailable P --reason …` | Block a provider's roles without substituting anyone |
| `modes --restore P [--note …]` | Return a provider's roles; the re-check debt survives |
| `modes --settle ID --evidence …` | Record that the owed re-check ran, with references |
| `modes --delegate A:B --model …` | Name the model the substitute answers with, when its roles carry none |
| `scan --repo PATH [--history]` | Check index blobs or every reachable history blob |

## Packet

[Example](../../examples/map-task.json). Required fields: `taskId`, `role`, `mode`, `goal`,
`paths`, `authority`, and nonempty `criteria` with unique IDs. Optional fields include
`acceptedDecisions`, `exclusions`, `base`, `worktree`, `model` and `effort`.

Modes are `snapshot`, `design`, `diff`, `live` and `eval`. They describe the task; `live`
does not automatically grant a model access to Obsidian. Host operations remain coordinated.
`diff` requires a valid base and nonempty comparison. `snapshot` does not.

`paths` describes task scope and is checked for path escape. It is not an operating-system
write allowlist. A writing worker is confined to its worktree by the provider's restricted
file tools. Review the complete resulting diff for scope compliance.

Provider/model values are explicit in the job record. The order is: the packet, then the
role's assignment in local configuration, then the role's own default, then the provider
default in `models`. A packet may override model and effort, but cannot increase role
authority. A missing model blocks execution instead of silently selecting a changing default.

## Result

The [result schema](../../config/result.schema.json) requires a matching task ID, one outcome
per criterion, findings and unknowns. PASS requires evidence references. Syntax validation
does not prove that a reference supports the claim; independent adjudication remains needed.

## Worktrees and checks

The initial release creates a source worktree with minimal instructions. It does not install
dependencies or copy secrets. Prepare dependencies under the project's documented procedure.
`check-project` runs the main managed checkout; checks for a worker checkout must be run by
the coordinator in that explicit checkout. Never report one checkout's checks as another's.

Retiring a worktree needs one check first. A worker checkout often shares the main checkout's
installed dependencies through a Windows junction at `node_modules`, and `git worktree remove`
deletes the directory recursively: it follows that junction and empties the shared installation
the main checkout is using. Remove the link before the worktree — `cmd /c rmdir "<worktree>
ode_modules"`
deletes a junction without touching its target — or verify with
`Get-Item <path> -Force` that `node_modules` is a real directory. If the installation is already
gone, `npm ci` in the main checkout restores it; nothing tracked is lost, but every check fails
in the meantime with a missing executable rather than a real defect.

## Delegation between providers

`modes` opens one frame in an interactive terminal and prints the same frame once anywhere
else. A delegation is opened by the human, names the absent provider, the substitute and a
reason, and never widens authority, chains through an unavailable provider, or turns a single
family's second opinion into independent review. Each job produced under one carries
`delegation`, `independence: SINGLE_MODEL` and `recheck: OWED`; restoring the provider closes
the delegation without paying that debt. See [the delegation guide](../how-to/delegation.md).

## State configuration

`.claudex.json` points to `.local/claudex/workspace.json`, schema version 2. Local fields
include the relative project, profile, access mode, per-role assignments, provider executable
paths, provider default models, maximum managed workers, readiness/execution deadlines and
Obsidian vault identity. Core code does not edit global provider authentication or settings.

A version 1 file is read as `access: "scoped"`, because that is what version 1 enforced: a
writer needed its own worktree on a feature branch and nothing more. Reading a workspace
migrates it in memory only; `sync` writes the upgrade down, so an upgrade happens once and
visibly. `doctor` reports a file that is still on the older version.

### Access modes

| Mode | A writing task |
|---|---|
| `full` | runs as soon as its packet is valid |
| `scoped` | runs only in its own worktree, on a feature branch |
| `approval` | also needs a one-shot approval recorded for that exact task |

Reading and reviewing are never gated. A fresh installation is `approval`; the approval is a
file under `.local/claudex/approvals/`, spent by the worker that uses it, so one approval
cannot start a second writer with the same task name. See
[the setup guide](../how-to/setup.md).

### Assignments

`assignments` maps a role to `{ provider, model, effort }`, and only the differences from the
role default are stored, so an upstream change to the role table still reaches the
installation. A role whose authority is `workspace-write` cannot be assigned to a provider
whose adapter is read-only; the setup window and `settings` both refuse it before it is
written.

## Scopes and worktrees

A writing job claims the paths its packet declares, and a worktree claims the paths given to
`worktree --paths`. A second writer over the same files is refused unless the overlap is
recorded with a reason. Read-only work claims nothing: two reviewers reading the same file
are not a collision.

`worktree --retire` is the way to finish with a checkout. It refuses uncommitted work, an
unfinished merge or commits that are not in the base branch, unless forced with a recorded
reason. Before removing the directory it removes the harness's own generated pointers and
detaches shared dependency links, because `git worktree remove` deletes recursively and would
otherwise follow a junction into the installation the main checkout is using.

## Reports

Every push through the guard appends one line to `.local/claudex/reports/pushes.jsonl`: the
time, the remote, its URL and each ref with both object IDs. It is written by the boundary the
push physically crosses rather than by whoever made it, which is the difference between a
record and a claim.
