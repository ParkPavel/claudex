# Publish and protect Claudex

For a separate existing product, use the [product guard adoption guide](product-guards.md).

The desktop directory is not a Git repository for publication. Create the remote for the
`claudex` folder only. Authentication remains in the user's credential manager or GitHub CLI.

## Prepare the exact tree

Run `npm run verify`, inspect `git status`, stage the intended public files, and run
`node bin/claudex.mjs scan --repo .`. Before publishing existing history, add `--history`.
Install the repository hooks with `npm run hooks:install`, then verify them with
`git config --get core.hooksPath`; the result must resolve to
the harness `.githooks` directory. Do not disable hooks to work around a finding.

## Initial empty repository

Only initial publication may bootstrap an empty `main`. After explicit authorization, create
`.git/claudex-initial-publication.json` containing the exact local commit SHA, destination URL,
`ref: "refs/heads/main"`, and an expiry timestamp in milliseconds. The guard requires the
remote branch to be absent and consumes the permit. Reissue it only after understanding a
failed attempt. This exception does not permit later direct pushes to `main`.

## Normal releases

Work on a feature branch, push it through the hook, then use a pull request. Require passing
checks, resolved review conversations and appropriate approval. Existing tags are immutable;
publish a new version instead of rewriting one. Review generated release notes for private
paths and artifacts before creating a release. From the clean release commit, run
`npm run release:archive`; publish both the resulting ZIP and its `.sha256` file from the
local `artifacts/` directory.

On GitHub, enable branch protection for `main`: reject force pushes and deletion, require
pull requests and checks, and apply restrictions to administrators. A single-maintainer
project may choose zero external approvals while retaining PR/check requirements; record
that choice instead of claiming independent approval. Enable secret scanning/push protection
and private vulnerability reporting where supported, and verify their actual server state.

Source: [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
