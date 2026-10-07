> [!WARNING]
> **Archived.** Claudex was cooked well done and went into the pot as an ingredient of
> the borshch — **[Borshkit](https://github.com/ParkPavel/borshkit)**. This repository is
> read-only; 1.1.0 is the last version. Why the meat went into the soup:
> [review of the reasons for archiving](ARCHIVED.md).

<div align="center">

# Claudex

**One workspace · one shared contract · Claude Code and Codex working against the same evidence**

**English** · [Русский](README.ru.md)

[![Status: archived → Borshkit](https://img.shields.io/badge/status-archived%20%E2%86%92%20borshkit-b3261e.svg)](ARCHIVED.md)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js ≥ 22](https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=node.js&logoColor=white)](package.json)
[![Runtime dependencies: none](https://img.shields.io/badge/runtime%20deps-none-brightgreen.svg)](package.json)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)](docs/how-to/setup.md)
[![Providers](https://img.shields.io/badge/providers-Claude%20Code%20%2B%20Codex-8A2BE2.svg)](docs/explanation/architecture.md)
[![Profiles](https://img.shields.io/badge/profiles-generic%20%7C%20obsidian-orange.svg)](#profiles)

</div>

Claudex is a small, local-first harness for developing with two AI providers on a real product.
It keeps the maintained instructions in one place, gives every job an explicit role and a pinned
source snapshot, and keeps a model's *"done"* apart from verified acceptance.

> **The one idea.** Completion is decided by evidence bound to the exact state it was taken
> from — source, configuration and specification digests — and a different model reviews what
> one model produced. Anything not shown stays `UNKNOWN`; it never becomes `PASS` by default.

---

## Contents

[Quick start](#quick-start) · [How a task flows](#how-a-task-flows) · [Profiles](#profiles) ·
[Reports](#reports) · [Skills and library](#skills-and-reference-library) · [Security](#security) ·
[References](#references) · [Documentation](#documentation)

## Quick start

*Starting something new? Go straight to [Borshkit](https://github.com/ParkPavel/borshkit) —
what follows is kept for existing installations.*

Requirements: Node.js 22+, Git, and logged-in Claude Code and Codex CLIs. The managed project is
its own Git repository next to `claudex/`.

```sh
git clone https://github.com/ParkPavel/claudex.git
cd claudex
node bin/claudex.mjs setup --workspace ..
```

The setup window writes nothing until you confirm its summary. In order, it:

1. **shows the environment** it found — node, git, both provider CLIs — so a missing tool is
   found now, not by the first failed job;
2. asks for the **managed project** and lists what will be created around it;
3. offers the **profile** the project looks like (an Obsidian manifest → `obsidian`);
4. asks **what a writer may do without asking** (`full`, `scoped`, `approval`);
5. asks **which model answers for which role**, one line per role;
6. records **working principles** — the language to answer in, the protected branch, who merges,
   the checks required before "done" — so no agent ever relays your consent secondhand;
7. offers to install the **Claude Code hooks**, and ends by running `doctor`.

Run it again at any time to change an answer. A script uses `init` with flags instead. A release
archive installs by unpacking and opening `setup.cmd` (Windows) or `setup.sh` (Linux/macOS).

## How a task flows

```text
 task init ──► task check ──► worktree + approve ──► run (implementer) ──► task verify
  contract      warnings        isolated checkout       writes on a            checks bound
                                                         feature branch         to the snapshot
                                                                                     │
 task converge ◄── wait / report ◄── run (auditor, other provider, read-only) ◄──────┘
  PASS · FAIL · UNKNOWN per criterion
```

| Step | Command | What it guarantees |
|---|---|---|
| Contract | `task init <id>` → edit → `task check <id>` | Goal, non-goals, decisions, paths, criteria, checks. `check` also **warns** about criteria no check can show, placeholders, code without a type checker or linter, and checks your principles require |
| Isolation | `worktree <id> --paths src/lib` | A writer gets its own checkout and claims its files; overlaps need a recorded reason |
| Job | `run packet.json` | Background worker, exact job ID, pinned snapshot, role-bound provider and model |
| Evidence | `task verify <id> --check <check>` | The check's log and digests are stored; a later edit makes it `STALE` |
| Review | `run review.json` | A read-only reviewer from the other provider receives the checks already run on its snapshot |
| Waiting | `wait [job] --timeout-min 40` | Blocks until jobs finish and prints verdicts, gaps and postmortems |
| Verdict | `task converge <id>` | `PASS`, `FAIL` or `UNKNOWN` per criterion, with scope violations and provenance |

## Profiles

A profile carries the checks and working instructions for one kind of project.

| Profile | Required files | `check-project` runs | Live evidence |
|---|---|---|---|
| `generic` | — | nothing by default; your contract's checks | — |
| `obsidian` | `manifest.json`, `package.json` | isolated `npm run build`, `npm test` (JSON report), `npm run lint` | Obsidian CLI against a declared **test** vault; production vaults stay read-only |

Project-specific invariants live in the local `.local/claudex/project-profile.md`, together with
the working principles recorded by setup.

## Reports

| Report | Command | Answers |
|---|---|---|
| Job summary | `status --summary` | What is running, what finished, where the postmortem is |
| Verdicts on completion | `wait [job …]` | Criteria, findings, unanswered criteria (`resultGaps`), termination |
| Postmortem | `artifacts/<job>/postmortem.json` | What the job promised, where it stopped, the provider's own error, leftovers, next checks |
| Retrospective | `retro [--since DATE]` | Failure causes, per-model jobs, cost and tokens, share of `UNKNOWN`, slowest runs |
| Workspace health | `doctor` | Entrypoints, providers, worktrees, claims, delegations, approvals, orphan jobs |
| Provider handover | `modes --status` / `--debt` | Who answers for whom, and which re-checks are owed |
| Session handoff | hooks | Project state at session start, a line per stop, finished reports carried into the next turn |

## Skills and reference library

Skills are short, maintained instructions; generated stubs point to them from `.claude/skills`
and `.agents/skills`.

| Skill | Use it to |
|---|---|
| `spec-workflow` | bind a feature or fix to a contract and current evidence |
| `task-contract` | hand a bounded question to another agent |
| `systematic-diagnosis` | find the cause before changing code; read every failing suite's reason |
| `evidence-gate` | judge a completion claim against evidence |
| `flow-render` | trace one user action from the visible promise to the persisted effect |
| `obsidian-acceptance` | plan live checks through the Obsidian CLI |
| `native-ui-quality` | hold an interface to the iOS quality bar, including Obsidian mobile |

`library/` is a local reference of worked solutions — Emil Kowalski's design-engineering skills
and a distilled Apple Human Interface Guidelines — read on demand through `native-ui-quality`,
never injected wholesale. See [library/README.md](library/README.md) for provenance and licenses.

## Security

- **Nothing local is published.** Configuration, jobs, evidence, approvals and backups live in
  `.local/` of your workspace, outside this repository. Credentials stay in the provider CLIs.
- **Authority is structural.** Codex runs in a read-only sandbox; Claude's managed writer gets
  confined file tools and no shell; writers need a worktree on a feature branch.
- **Publication is guarded.** `scan` checks staged content and history for secrets; the push
  guard refuses protected refs, force pushes and deletions, and journals every push.
- **Hooks run without a shell.** Installed hooks use exec form, so a path is never a command.

Read the full [threat model](SECURITY.md).

## References

Everything Claudex adapted, borrowed from or evaluated. Details: [lineage](docs/explanation/lineage.md).

| Source | Used for |
|---|---|
| [github/spec-kit](https://github.com/github/spec-kit) | the task contract; `task check` warnings follow its `analyze` pass |
| [obra/superpowers](https://github.com/obra/superpowers) | skills, worktree isolation, test-before-fix |
| [Graphify](https://github.com/Graphify-Labs/graphify) | vendored code graph (`vendor/graphify`) |
| [kvyb/prompt-agent](https://github.com/kvyb/prompt-agent) | session scoring → `retro` |
| [emilkowalski/skills](https://github.com/emilkowalski/skills) | design engineering, motion, web-on-phone (`library/emil`) |
| [justinwetch/HIGAgentSkills](https://github.com/justinwetch/HIGAgentSkills) | distilled, routed HIG (`library/apple-hig`, local reference) |
| [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines) | the primary source behind the HIG library |
| [Claude Code hooks](https://code.claude.com/docs/en/hooks) | hook events, exec form, `Bash\|PowerShell` matcher |
| [TypeSafe agent skill](https://docs.typesafe.ai/agent-skill) | evaluated; not integrated |

## Documentation

| | |
|---|---|
| **Learn** | [Architecture and state model](docs/explanation/architecture.md) · [Lineage and thanks](docs/explanation/lineage.md) |
| **Install** | [Install and adapt](docs/how-to/setup.md) |
| **Operate** | [Specification workflow](docs/how-to/spec-workflow.md) · [Provider handover](docs/how-to/delegation.md) · [Obsidian CLI](docs/how-to/obsidian.md) · [Code graph](docs/how-to/graph.md) · [Publication](docs/how-to/publication.md) · [Migration](docs/how-to/migration.md) |
| **Reference** | [Commands and contracts](docs/reference/commands.md) · [Release notes](CHANGELOG.md) · [Security](SECURITY.md) |

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). `vendor/graphify` keeps its own
Apache-2.0/MIT licenses; `library/emil` is MIT; `library/apple-hig` declares no license and is
kept for local reference only.
