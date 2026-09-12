# Install and adapt the harness

Claudex arrives with defaults that suit no one exactly: which project it manages, how much it
may do without asking, and which model answers for which role are decisions about your
machine and your budget. The setup window asks for those and writes nothing else.

```sh
git clone https://github.com/ParkPavel/claudex.git
cd claudex && npm ci
node bin/claudex.mjs setup --workspace ..
```

The window opens where a person can answer it. In a script, `init` takes the same decisions
as flags and never prompts.

## Install a release archive

The release ZIP is the shortest path for a new user:

1. Put the ZIP in the directory that will contain both Claudex and the managed project.
2. Extract it. The resulting directory is named `claudex`.
3. On Windows, open `setup.cmd`. On Linux or macOS, run `./setup.sh`.
4. Answer the installation window and confirm its summary.
5. Run `node claudex/bin/claudex.mjs doctor` from the parent directory.

The launcher defaults the workspace to the directory containing `claudex`. A different path
can be passed as its first argument. The managed project must already be a separate Git root
inside that workspace. The archive carries no npm dependencies and needs no `npm install`.

Before unpacking, compare the archive against the published checksum:

```sh
# Linux or macOS
sha256sum -c claudex-<version>.zip.sha256

# PowerShell
(Get-FileHash .\claudex-<version>.zip -Algorithm SHA256).Hash
```

## What it asks

**The managed project.** A folder next to the harness that is its own Git repository. The
window refuses the workspace root, a folder that does not exist and a folder inside another
repository, because each of those breaks a promise the harness makes later.

Before asking, it lists what will be created around that project:

```text
.claudex.json                pointer to the local state directory
.local/claudex/              configuration, jobs, evidence, approvals, reports
.local/claudex/worktrees/    isolated checkouts for writing tasks
.tmp/                        disposable scratch space
AGENTS.md, CLAUDE.md         generated entrypoints pointing at the shared contract
.codex/, .claude/, .agents/  generated native role and skill definitions
```

None of it belongs in a public repository, and the generated `.gitignore` in the workspace
root says so. Your credentials stay in your own provider CLIs; nothing is copied here.

**The profile.** `generic` states the shared contract only. `obsidian` adds plugin checks and
live evidence through the Obsidian CLI.

**What the harness may do without asking.**

| Mode | A writing task |
|---|---|
| `full` | runs as soon as its packet is valid |
| `scoped` | runs only in its own worktree, on a feature branch |
| `approval` | also needs your one-shot approval for that exact task |

Reading and reviewing are never gated: the modes differ in what may be changed, not in what
may be looked at. A fresh installation is `approval`, and an approval is one task, one use:

```sh
node bin/claudex.mjs approve T-42 --reason "Reviewed the plan and the scope of the writer"
```

An installation upgraded from the previous configuration version is read as `scoped`, because
that is what it actually enforced. Nothing silently gains a protection it never had, and
nothing silently loses one.

**Providers and models.** The executable each provider is launched with, and the model used
when a role does not name one of its own.

**Roles.** One line per role, in the same shape as the `--assign` flag:

```text
architect (read-only) [claude/opus@high]: codex/gpt-5.6-terra@max
implementer (workspace-write) [claude/opus@high]:
auditor (read-only) [codex@high]: skip
```

Press Enter to keep what is shown; `skip` keeps every remaining role. Only differences from
the role default are stored, so a table that changes upstream still reaches you.

A role that writes cannot be moved to a provider whose adapter is read-only. The window says
so at the prompt rather than letting the job fail hours later.

## Changing it afterwards

The same window, on an existing workspace:

```sh
node bin/claudex.mjs setup --workspace ..
```

Or without prompts:

```sh
node bin/claudex.mjs settings --show
node bin/claudex.mjs settings --access scoped
node bin/claudex.mjs settings --assign architect=codex/gpt-5.6-terra@max --assign tester=claude/sonnet
```

`settings` validates before it writes: an assignment that cannot work is refused with the
reason, and the stored configuration is never left in a state a job would discover.

After changing anything, run `doctor`. It reports the access mode, the assignments in effect,
the state of every worktree, open scope claims, open delegations and outstanding approvals —
the things that are otherwise only visible to whoever remembers to look.
