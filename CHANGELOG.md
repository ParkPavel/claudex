# Changelog

## Unreleased

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
has not been established; see [validation](docs/research/validation.md).
