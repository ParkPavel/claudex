# Changelog

## Unreleased

- `task init|check|verify|record|converge` bind a feature or fix to a local contract and
  report PASS, FAIL or UNKNOWN per criterion against current, snapshot-bound evidence.
  `workflow.requireContract` makes writing jobs name their contract.
- A job that ends FAILED or TIMED_OUT leaves `postmortem.json` next to its artifacts: what
  the packet promised, the stage it stopped at, the provider and model, uncommitted changes
  left in its repository and what to check before retrying. `status --summary` points at it.
  A cancellation is a person's decision and gets no postmortem.
- Task checks can run isolated (`isolate`) in a disposable copy with linked `node_modules`,
  and compare a build's output with tracked and deployed files (`reproduces`, optional
  `eol: "ignore"`). The obsidian profile's build check in `check-project` is isolated too, so
  neither rewrites the checkout's bundle.
- The result schema states that findings are defects only; confirmations go to evidence.
- Graphify 0.9.66 is vendored in vendor/graphify with two changes proposed upstream: a
  document's reference to code outside its extraction chunk is kept for the graph builder to
  resolve instead of being dropped with the misattributed node, and on Windows the
  PYTHONHASHSEED re-exec runs as a child process (the emulated exec crashed silently). `graph build|status|query|path|
  explain` build the project graph outside the repository, add EXTRACTED/INFERRED document →
  code links and list UNVERIFIED paths; a CURRENT graph's slice for a job's paths is projected
  into its prompt. See docs/how-to/graph.md and docs/explanation/lineage.md (attribution and
  thanks to Spec Kit, Superpowers and Graphify).
- `graph trace` records the bundler's metafile from the project's own esbuild script, run
  unchanged in an isolated copy, and merges it as EXTRACTED import, `bundled_into` and
  `merged_into` edges. Default root-folder exclusions (releases, images, coverage) are anchored
  as /name/**; node_modules and .git still match at any depth. Isolation redirects writes
  relative to the working folder; it is not a sandbox (docs/how-to/graph.md).

## 0.2.0 — 2026-09-13

### Distributable setup

- A clean source snapshot can be built as a self-contained ZIP with
  `npm run release:archive`. The build verifies the archive, executes its CLI and writes a
  SHA-256 checksum next to it.
- `setup.cmd` and `setup.sh` start the existing installation window directly after unpacking;
  no dependency installation is needed because Claudex has no runtime packages.
- The `obsidian` profile now collects its executable, vault identity, absolute path and
  test-mutation boundary in the setup window instead of requiring a manual JSON edit later.
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
