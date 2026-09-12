# Commands and task contracts

Project check arguments may contain `{artifactDirectory}`; the runner replaces it with that
run's private output directory as one argument. The Obsidian profile writes its Jest JSON
report there, alongside command logs and the source-bound check record.

Run `node claudex/bin/claudex.mjs help` from the workspace desktop. When outside it, pass
`--workspace <desktop>`. The working directory is resolved to the managed Git root rather
than inferred from the currently focused application.

| Command | Result |
|---|---|
| `init --workspace … --project …` | Create local configuration and small native entrypoints |
| `sync` | Update generated files only when their previous hashes match |
| `doctor` | Check entrypoints, project prerequisites, provider executables, CLI and orphan jobs |
| `worktree TASK --base REF` | Create a dedicated branch/worktree and instruction entrypoints |
| `run PACKET [--wait]` | Submit a task; background by default, exact job ID returned |
| `status [JOB]` | Read all job records or one exact job |
| `cancel JOB` | Request cancellation; terminal state follows confirmed closure |
| `obsidian OP --params JSON [--write]` | Execute a scoped host operation and save evidence |
| `check-project` | Execute the selected profile's commands in the managed project |
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

Provider/model values are explicit in the job record. Local `models` overrides role defaults;
a packet may override model/effort, but cannot increase role authority. A missing Codex model
blocks execution instead of silently selecting a changing default.

## Result

The [result schema](../../config/result.schema.json) requires a matching task ID, one outcome
per criterion, findings and unknowns. PASS requires evidence references. Syntax validation
does not prove that a reference supports the claim; independent adjudication remains needed.

## Worktrees and checks

The initial release creates a source worktree with minimal instructions. It does not install
dependencies or copy secrets. Prepare dependencies under the project's documented procedure.
`check-project` runs the main managed checkout; checks for a worker checkout must be run by
the coordinator in that explicit checkout. Never report one checkout's checks as another's.

## State configuration

`.claudex.json` points to `.local/claudex/workspace.json`. Local fields include the relative
project, profile, provider executable paths, explicit model overrides, maximum managed
workers, readiness/execution deadlines and Obsidian vault identity. Core code does not edit
global provider authentication or settings.
