# Claudex

**One workspace. A shared contract. Claude Code and Codex working against the same evidence.**

Claudex is a small, local-first harness for coordinating AI-assisted development. It keeps
the maintained instructions in one repository, gives each job an explicit role and source
snapshot, and separates a model's completion claim from verified acceptance. Its Obsidian
profile uses the native Obsidian CLI for live evidence.

[Русская документация](README.ru.md) · [Architecture](docs/explanation/architecture.md) ·
[Security](SECURITY.md) · [Evidence register](docs/research/evidence-register.md)

## Workspace layout

```text
your-desktop/                       # Local workspace; do not publish this directory
├── claudex/                        # This public repository: maintained policy and tooling
├── your-project/                   # A separate Git repository
├── .local/claudex/                 # Machine configuration, jobs, evidence and backups
├── .tmp/                           # Disposable work; retention is your choice
├── .claudex.json                   # Small local workspace pointer
├── AGENTS.md                       # Generated Codex/shared entrypoint
├── CLAUDE.md                       # Generated Claude entrypoint
├── .codex/                         # Small generated native role definitions
├── .claude/                        # Small generated native role/skill definitions
└── .agents/                        # Small generated skill entrypoints
```

Only `claudex/` is this project's publication boundary. Vaults, private notes, screenshots,
conversations, credentials and arbitrary user folders stay outside it. Generated files point
to the maintained contract and skills; `sync` checks their hashes before updating them.

## Get started

Requirements: Node.js 22+, Git, authenticated Claude Code and Codex installations. The
Obsidian profile additionally needs the desktop CLI and a designated test vault. Windows
and Linux are covered by the CI configuration; real-host results are recorded separately.

```sh
git clone https://github.com/ParkPavel/claudex.git
cd claudex && npm ci
node bin/claudex.mjs setup --workspace ..
node bin/claudex.mjs doctor --workspace ..
```

`setup` opens a window and asks the things an installation cannot decide for you: which
project it manages, how much it may do without asking, and which model answers for which
role. It lists what it will create around your project before creating any of it. In a
script, `init` takes the same decisions as flags and never prompts.

Your managed project must already be a Git repository beside `claudex`. For Obsidian, choose
the `obsidian` profile and follow the [Obsidian setup guide](docs/how-to/obsidian.md).
Authentication stays with the provider CLIs; Claudex does not copy credentials into its
repository. See [install and adapt](docs/how-to/setup.md) for the full walkthrough.

## Adapt it to your stack

| Decision | Default | Change it with |
|---|---|---|
| What a writer may do without asking | `approval` — one recorded approval per writing task | `settings --access full\|scoped\|approval` |
| Which model answers for a role | The shared role table | `settings --assign architect=codex/gpt-5.6-terra@max` |
| Which files a task owns | Declared per task, claimed while it runs | `worktree TASK --paths docs,src/lib` |

Reading and reviewing are never gated; the access modes differ in what may be changed. A role
that writes cannot be assigned to a read-only provider, and the refusal happens where the
choice is made rather than when the job runs.

## Run a bounded task

Copy [the example packet](examples/map-task.json) to local storage and set its objective,
paths and criteria. From the desktop directory:

```sh
node claudex/bin/claudex.mjs run .local/map-task.json --wait
node claudex/bin/claudex.mjs status
node claudex/bin/claudex.mjs cancel JOB_ID
```

Without `--wait`, submission returns immediately and a hidden background coordinator runs
the exact job. Inspect it by ID. `COMPLETED` means the provider returned a valid result;
`proposedAcceptance` is the model's assessment. The job's acceptance remains `UNKNOWN`
until independently adjudicated evidence is recorded outside that proposal.

Writing tasks require a separate worktree, and — in the default access mode — an approval:

```sh
node claudex/bin/claudex.mjs worktree implement-one-change --base HEAD --paths src/lib
node claudex/bin/claudex.mjs approve implement-one-change --reason "Reviewed the plan and its scope"
```

Assign the returned path to an `implementer` packet. Claude's managed worker uses confined
file tools; it does not receive an unrestricted shell. The coordinator runs project checks
with `check-project`. When the work is finished, retire the checkout through the harness —
`worktree --retire` detaches shared dependency links before git deletes the directory — and
see the [command reference](docs/reference/commands.md) for the rest.

## What is implemented

| Capability | Boundary |
|---|---|
| Shared roles and five focused skills | One maintained body, generated native entrypoints |
| Structured jobs and common concurrency limit | Managed Claudex jobs; unrelated CLI sessions are outside the scheduler |
| Pinned source and configuration evidence | Full Git HEAD plus tracked/relevant untracked content hashes |
| Read-only reviewers | Codex read-only sandbox; Claude restricted file tools; no write escalation |
| Obsidian evidence capture | Explicit vault identity, local artifacts, test-vault mutation gate |
| Publication guards | Staged/history secret checks, protected refs, fast-forward and deletion checks |
| Recovery visibility | Exact job IDs, readiness deadlines, cancellation and orphan diagnosis |
| Installation window | Project, access mode, providers and per-role models, collected before anything is written |
| Access modes | `full`, `scoped`, `approval`; one-shot approvals spent by the worker that uses them |
| Scope claims | Writing tasks declare and claim their files; an overlap needs a recorded reason |
| Worktree visibility and retirement | Uncommitted work, unfinished merges and shared installs are reported, and links are detached before removal |
| Recorded provider handover | A quota that ends becomes a delegation with an owed re-check, never a silent substitution |
| Push journal | Every push through the guard appends a line written by the boundary, not by its author |

Claudex 0.1.0 is an initial engineering release. It does not claim benchmark superiority,
perfect secret detection, automatic recovery of orphan processes, or autonomous product
acceptance. Read [the threat model](SECURITY.md) and [validation boundaries](docs/research/validation.md).

## Documentation

- **Learn:** [architecture and state model](docs/explanation/architecture.md).
- **Install:** [install and adapt](docs/how-to/setup.md).
- **Operate:** [Obsidian CLI](docs/how-to/obsidian.md), [provider handover](docs/how-to/delegation.md), [migration](docs/how-to/migration.md), [publication](docs/how-to/publication.md).
- **Reference:** [commands and contracts](docs/reference/commands.md).
- **Evaluate:** [research sources](docs/research/evidence-register.md), [validation](docs/research/validation.md).
- **Contribute:** [contribution guide](CONTRIBUTING.md), [release notes](CHANGELOG.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). External methods are cited as design
influences; this repository does not vendor complete third-party skill libraries.
