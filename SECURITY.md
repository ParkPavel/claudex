# Security model

Claudex protects a publication boundary and constrains its managed workers. It is not a
general-purpose operating-system sandbox and does not establish trust in downloaded code.

## Private data boundary

Only the harness repository is publishable. Local workspace configuration, vault contents,
provider credentials, transcripts, screenshots, backups and task artifacts live outside it.
The secret scanner checks staged Git blobs and reachable history, reporting kind/path/line
without matched values. It detects selected credential formats and private locations; it
cannot recognize every secret or sensitive image. Review the publication tree as well.

## Managed workers

Read-only roles cannot request write authority. Codex uses its read-only sandbox with user
configuration excluded. Claude uses restricted mode with an explicit file-tool set; MCP and
arbitrary shell tools are excluded. A writing role is assigned a separate project worktree.
Role scope paths are intent, not an OS allowlist. Treat provider/version regressions as
security-relevant and verify the actual host.

Prompt injection in source material cannot grant authority under the shared contract. Tool
restrictions provide a second boundary; they do not make arbitrary source content trustworthy.
Native interactive sessions and unmanaged external agents are outside the job scheduler.

## Push controls

The pre-commit hook scans index content and rejects established protected-branch commits.
The pre-push hook rejects protected-branch updates, remote deletions, non-fast-forward changes
and modifications to existing tags; it scans all history reachable from proposed tips.
Initial publication has an exact-SHA, exact-URL, expiring local permit for an empty remote
branch. That permit is consumed by the hook and is not a substitute for user authorization.

Git hooks can be bypassed by someone controlling the machine. Enforce protected branches,
required checks and restricted bypass permissions on GitHub. CI uses read-only repository
permissions and never runs untrusted pull-request code with publishing credentials.

## Reporting

Use GitHub private vulnerability reporting if enabled, or contact the maintainer privately.
Do not put credentials, private vault content or exploit data from another person's machine
in a public issue. Include affected version, boundary, minimal reproduction and expected
behavior. No security-reporting address is invented by this project.
