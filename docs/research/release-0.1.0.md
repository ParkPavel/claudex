# Claudex 0.1.0: release evidence

Recorded on 2026-09-10, and left as recorded. This page is a snapshot of one release, not
a description of the harness as it stands: the numbers below were true that day. This is an
integration record, not a comparative benchmark.
The repository commit containing this record identifies the public source tree. Detailed
job journals, configuration digests and host artifacts remain in private workspace storage.

## Verification matrix

| Boundary | Observation | What it establishes |
|---|---|---|
| Local automated suite | 27 tests passed on Windows; static syntax and Markdown links passed | Fixture contracts for coordination, configuration, evidence and Git guards |
| Codex CLI 0.154.0 | Native read-only manifest task returned matching structured evidence with unchanged source digest; selected model `gpt-6-astra`, medium effort | Provider startup, authenticated execution, file reading and result parsing |
| Claude Code 2.1.267 | Native restricted manifest task returned matching structured evidence with unchanged source digest; `opus` resolved to `claude-opus-5`, high effort | Provider startup, native OAuth, restricted file tools and result parsing |
| Obsidian 1.13.7, installer 1.13.7 | Explicit vault identity; unique note created, verified on disk, read after plugin reload; DOM and screenshot captured; note cleaned up | Native CLI integration and note persistence in the designated test vault |
| Migrated project | Build, Jest, lint and Svelte checks passed; Svelte reported zero errors and warnings | The configuration extraction did not break these project checks |
| Migration | Retired settings backed up with matching hashes; five Git worktrees relocated with their HEAD and dirty state preserved | Local migration preserved existing work and recovery material |
| Publication | Staged/history scans run through Git hooks; CI runs separately on Windows and Ubuntu | See the actual [CI runs](https://github.com/ParkPavel/claudex/actions/workflows/ci.yml) for each published commit |

`COMPLETED` jobs retain `acceptance: UNKNOWN`. For the manifest smoke tasks, the coordinator
also compared the reported identifier and version against the actual file. A provider's
own proposed PASS was not used as sole evidence.

## Limits and observed issues

- The test vault's installed plugin bundle differed from the local project build. The host
  smoke establishes the CLI integration; it does **not** accept the current product build.
  Both bundle hashes are captured in local evidence.
- Real provider and desktop checks were performed on Windows. Ubuntu CI exercises the
  fixture suite, not an authenticated provider or graphical Obsidian installation.
- The installed older Codex client could not run the selected model. A workspace-local
  0.154.0 client was used; global user authentication was preserved.
- Claude bare mode skipped native OAuth. The adapter instead uses safe mode plus restricted
  tools and an empty MCP configuration. Windows Codex explicitly selects its elevated
  sandbox implementation while retaining read-only filesystem authority.
- The smoke tasks did not adversarially verify every native sandbox boundary. Secret
  scanning is defense in depth and cannot guarantee detection of every secret format.
- There is no completed benchmark showing Claudex outperforming another harness or proving
  a fixed token saving. Follow the [evaluation protocol](validation.md) before making one.

## Maintainer policy

The initial single-maintainer repository requires pull requests and both CI checks for
`main`, including administrator changes. It requires zero external approvals; this is not
independent human review. Force pushes and branch deletion are disabled. Secret scanning,
push protection and private vulnerability reporting are enabled and checked through GitHub.

For future releases, replace this dated observation with a new record. Do not edit old
results to make them describe a new model, host version, configuration or source snapshot.
