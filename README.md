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
cd claudex
npm install
node bin/claudex.mjs init --workspace .. --project your-project --profile generic
node bin/claudex.mjs doctor --workspace ..
```

Your managed project must already be a Git repository beside `claudex`. For Obsidian,
select `--profile obsidian --vault "Your Test Vault"` and follow the
[Obsidian setup guide](docs/how-to/obsidian.md). Fill in the explicit Codex model and local
executable/vault settings in `.local/claudex/workspace.json`. Authentication stays with the
provider CLIs; Claudex does not copy credentials into its repository.

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

Writing tasks require a separate worktree:

```sh
node claudex/bin/claudex.mjs worktree implement-one-change --base HEAD
```

Assign the returned path to an `implementer` packet. Claude's managed worker uses confined
file tools; it does not receive an unrestricted shell. The coordinator runs project checks
with `check-project`. See the [command reference](docs/reference/commands.md) for limits.

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

Claudex 0.1.0 is an initial engineering release. It does not claim benchmark superiority,
perfect secret detection, automatic recovery of orphan processes, or autonomous product
acceptance. Read [the threat model](SECURITY.md) and [validation boundaries](docs/research/validation.md).

## Documentation

- **Learn:** [architecture and state model](docs/explanation/architecture.md).
- **Operate:** [Obsidian CLI](docs/how-to/obsidian.md), [migration](docs/how-to/migration.md), [publication](docs/how-to/publication.md).
- **Reference:** [commands and contracts](docs/reference/commands.md).
- **Evaluate:** [research sources](docs/research/evidence-register.md), [validation](docs/research/validation.md).
- **Contribute:** [contribution guide](CONTRIBUTING.md), [release notes](CHANGELOG.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). External methods are cited as design
influences; this repository does not vendor complete third-party skill libraries.
