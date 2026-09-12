# Guard an existing product repository

Install the hooks from the maintained Claudex checkout with an **absolute** `core.hooksPath`
in the product repository. The hook resolves its executable from its own directory, so it
works when the product is the current Git root. Preserve any existing hooks before changing
this setting; do not silently replace another tool's checks.

## Existing public history

Claudex itself scans all reachable publication history. An older product may already contain
published machine paths or intentional release artifacts. For that product only, the owner
may set local Git configuration `claudex.publicationBaseline` to the exact reviewed public
commit SHA. This is a recorded adoption boundary, not a declaration that old history is clean.

The guard requires that baseline to be an ancestor of each proposed tip. It exempts only
unchanged path/blob pairs present at the baseline, scans new or changed blobs in every later
commit, and therefore still catches a newly introduced secret deleted in a subsequent commit.
Moving an old blob to a new private path is also checked. Existing symlinks and submodules
are not silently exempted. Do not advance the baseline automatically to make a push pass.

Keep the baseline and hook installation in local Git settings, outside public task data.
This local policy does not replace GitHub secret scanning or protected branches. Retain PR
and required-check enforcement on the server; remove CI jobs that push directly to `main`.
Tracked release bundles remain supported; inspect changed bundle contents like other files.

## Artifact retention

Each executed managed job records its artifact directory before starting the provider,
including failed, timed-out and cancelled executions. A preflight rejection before directory
creation need not have artifacts. Preserve task IDs, source/configuration digests and the
recorded acceptance boundary when moving evidence; do not infer success from file existence.
