# Migrate a scattered agent setup

## Inventory before removal

List project-local `.claude`, `.codex`, `.agents`, `AGENTS.md`, `CLAUDE.md`, editor-specific
agent files and their callers. Separate executable configuration, secrets, memory, evidence
and Git worktrees. Inspect registered worktrees with `git worktree list --porcelain`.
Do not recursively delete a directory that contains working branches.

Make a private backup outside both public repositories, preserve relative paths and verify
SHA-256 hashes. Archive credential-bearing files without printing their contents. A backup
is a recovery artifact, not another active configuration layer.

## Switch ownership

Initialize Claudex in the desktop root. Put product-specific invariants and canonical document
references in `.local/claudex/project-profile.md`. Keep global provider authentication intact.
Move registered worktrees using `git worktree move` into local storage and verify their Git
registration and status before removing the old parent directories.

Validate generated entrypoints and run the new tests. Once their replacements are available,
remove the inventoried old active settings. Preserve private memory/evidence separately;
do not reactivate it as policy. Do not copy obsolete benchmark counts into the new profile.

## Leave an explicit release note

The managed project should contain a short durable note:

> Agent orchestration and configuration moved to
> [Claudex](https://github.com/ParkPavel/claudex). The product repository retains its product
> contracts and acceptance evidence; workspace setup is maintained by the separate harness.

Update the next release notes and any active setup instructions. Historical retrospectives
may keep their old paths if clearly labelled historical. Replace current runbooks that still
instruct agents to call removed runners or rely on old REST credentials.

Configuration-specific tests belong with Claudex. Product invariants remain with the product.
Retired optional local checks must not be described as continuing to protect the new core;
link to the corresponding Claudex checks.

## Rollback

Stop managed jobs and inspect any surviving child process. Verify backup hashes, restore
only the inventoried settings and reverse registered worktree moves. Keep the new local
state until the rollback is verified. Never restore secrets into a public repository's index.
