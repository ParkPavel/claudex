# Vendored Graphify

- Upstream: https://github.com/Graphify-Labs/graphify
- Base: 0.9.66, commit a5957aa6 ("release: 0.9.66 …")
- License: Apache-2.0 (LICENSE), portions MIT (LICENSE-MIT); upstream NOTICE kept as NOTICE.
- Local changes, both proposed upstream with tests (Claudex docs/explanation/lineage.md):
  1. c448efd6 "Keep a document's reference to code in another chunk for the builder to
     resolve" — graphify/llm.py (out-of-scope filter) and graphify/cache.py (#1916 pruning);
     sites marked `PROPOSAL (cross-file references)`.
  2. 3bea3fcc "Pin PYTHONHASHSEED on Windows with a child process, not an emulated exec" —
     graphify/__main__.py; site marked `PROPOSAL (Windows re-exec)`. Claudex also sets
     PYTHONHASHSEED=0 itself, which skips the re-exec entirely.
  3. f4ace0bc "Keep a cross-file reference only when the edge's own file was dispatched" —
     tightens change 1 after cross-provider review; adds import-family guard tests.

Only the `graphify/` package is vendored; tests stay upstream. Dependencies come from a
separately installed Graphify (`uv tool install graphifyy`); Claudex prepends `vendor/` to
PYTHONPATH so this copy is imported instead of the installed one.

To update: rebase the change onto a new upstream tag, rerun upstream's tests, replace this
directory with `git archive <commit> graphify`, and update the base above.
