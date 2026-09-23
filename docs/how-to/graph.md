# Code graph

Claudex builds a code graph of the managed project with its vendored Graphify
(`vendor/graphify`, see `docs/explanation/lineage.md`) and projects the relevant slice into
jobs. The graph is a navigation aid: it never counts as evidence.

## Setup

Install Graphify once for its dependencies (tree-sitter grammars and the rest), with a Python
of 3.10 or newer; `uv` fetches one if the system Python is older:

```text
uv tool install graphifyy --python 3.12
```

Point Claudex at that environment's Python in local `workspace.json`:

```json
"graph": {
  "python": "C:/Users/<you>/AppData/Roaming/uv/tools/graphifyy/Scripts/python.exe",
  "backend": "claude-cli",
  "model": "sonnet",
  "excludes": ["demo-vault", "templates", "translations"]
}
```

`PYTHONPATH` puts `vendor/` first, so the vendored, patched Graphify runs with the installed
dependencies. Do not run `graphify claude install` or `graphify codex install`: they rewrite
the entry points Claudex generates, and `doctor` would report drift.

## Build and check

```text
node claudex/bin/claudex.mjs graph build [--code-only]
node claudex/bin/claudex.mjs graph status
```

`build` parses code locally. Without `--code-only`, documents go to the configured backend;
`claude-cli` uses the signed-in Claude Code CLI. The run starts in a neutral directory so that
CLI does not load this workspace's hooks and instructions into every extraction call. Output
stays in `.local/claudex/graph/`: Graphify's `graph.json`, the linked `graph.linked.json` and
`graph-state.json` with the snapshot it was built from.

After Graphify, Claudex adds deterministic document → code edges:

- `EXTRACTED` — a document line names a path that exists as a file node, relative to the
  repository root or to the document's own folder;
- `INFERRED` — a document names a unique camel/Pascal/snake symbol in backticks, or a
  shortened path (`engine/aggregate.ts`) that exactly one file ends with;
- `UNVERIFIED` — a named path with no file node; listed in `graph-state.json`, never an edge.

`graph relink` reruns only this linker on the existing Graphify output, without a new
extraction. `status` is `CURRENT` only when the repository snapshot equals the one the graph was built
from; otherwise `STALE` or `MISSING`, and the exit code is nonzero.

## Navigation

```text
node claudex/bin/claudex.mjs graph explain "getRecord"
node claudex/bin/claudex.mjs graph path "docs/api.md" "viewApi.ts"
node claudex/bin/claudex.mjs graph query "where are records written?"
```

## Projection into jobs

When `graph` is configured (and `graph.project` is not `false`), each job's prompt receives
the edges that cross into or out of its declared paths, document edges first, each tagged
with its confidence and location, up to a fixed limit. A stale or missing graph yields one
line saying so; old edges are never presented as current. The job record keeps
`graph: {status, edges}`.

## Known limits

Tree-sitter parses `.svelte` files only partly: on one project about 210 files had parse
errors and the graph missed about a fifth of the callers that `git grep` found. Confirm a
"no callers" answer in source. Graphify may exclude a file it considers sensitive by name
(a design-token stylesheet was one); references to it appear as `UNVERIFIED`.
