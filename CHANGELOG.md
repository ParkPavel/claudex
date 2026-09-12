# Changelog

## Unreleased

## 0.2.0 — 2026-09-13

### Distributable setup

- A clean source snapshot can be built as a self-contained ZIP with
  `npm run release:archive`. The build verifies the archive, executes its CLI and writes a
  SHA-256 checksum next to it.
- `setup.cmd` and `setup.sh` start the existing installation window directly after unpacking;
  no dependency installation is needed because Claudex has no runtime packages.
- Release archives omit tests, CI, hooks, contributor material and dated research evidence.
  Those remain in the source repository; the installed harness keeps only runtime code,
  maintained policy, focused skills and user documentation.
- Focused skills no longer deep-link to the full research register; selecting a runtime skill
  does not force an unrelated documentation read.
- Installing Git hooks is now an explicit maintainer action (`npm run hooks:install`) rather
  than a side effect of packing the project.

### Installing and adapting

- `setup` opens an installation window: the managed project, the access mode, the provider
  executables and defaults, and which model answers for which role. It lists the directories
  it will create before creating them, and writes nothing until the summary is confirmed.
- `settings` reads and changes the same decisions without prompts, validating before it writes.
- Local configuration is schema version 2, adding `access` and per-role `assignments`. A
  version 1 file is read as `scoped`, which is what version 1 enforced; `sync` writes the
  upgrade down. Only differences from the role table are stored.
- Model resolution is packet, then the role's assignment, then the role default, then the
  provider default. A provider-wide default no longer flattens every role onto one model.

### What the harness may do without asking

- Access modes `full`, `scoped` and `approval`, with `approval` the default for a fresh
  installation. Reading and reviewing are never gated.
- `approve TASK --reason …` issues a one-shot permit, spent by the worker that uses it.

### Seeing the work in flight

- `doctor` reports every worktree — uncommitted work, unfinished merges, distance from the
  base branch, shared dependency links — plus open scope claims, delegations with an
  outstanding re-check, and approvals that expired unused.
- A writing task claims the files it declares. A second writer over the same files is refused
  unless the overlap is recorded with a reason; read-only work claims nothing.
- `worktree --retire` refuses unfinished work, detaches shared dependency links and removes
  the harness's own pointers before git deletes the directory.
- A delegation names the model its substitute answers with, so a handover cannot produce a job
  that fails for want of a model nobody chose.
- A provider failure is classified into a next step: a quota that ended prints the exact
  delegation command rather than a stack trace.
- Every push through the guard appends one line to a local journal, written by the boundary
  the push crosses rather than by whoever made it.

### Earlier in this release line

- Keep artifact-directory references for failed and interrupted provider runs.
- Support shared hooks for existing product repositories with an explicit public baseline;
  newly introduced blobs are checked across every proposed commit.

## 0.1.0 — 2026-09-10

Initial extraction of the shared agent harness into a separate public project.

- Shared workspace contract, native Claude/Codex entrypoints and nine role definitions.
- Five focused skills derived from published methods and local OBS engineering practice.
- Structured task packets, source/configuration snapshots, background jobs and cancellation.
- Read-only review roles and separate worktrees for implementation.
- Native Obsidian CLI adapter with explicit vault verification and local evidence capture.
- Staged/history publication scans, protected-branch guards and GitHub CI configuration.
- Migration guidance and source-linked architectural decisions.

This release establishes implementation contracts. Comparative model/skill effectiveness
has not been established; see the online
[validation notes](https://github.com/ParkPavel/claudex/blob/main/docs/research/validation.md).
