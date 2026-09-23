# Lineage, attribution and thanks

Claudex is built at the intersection of three published projects. Each solved one part of the
problem well; none of them covered the whole path from a stated intent to evidence that a
running plugin does what was promised. Claudex adapts their ideas to one harness and vendors
one of them.

| Project | License | What Claudex takes | How |
|---|---|---|---|
| [Spec Kit](https://github.com/github/spec-kit) — GitHub, Inc. | MIT | intent → specification → plan → tasks → convergence; separate assessment for defects | adapted as the local task contract (`task init/check/verify/record/converge`); no code copied |
| [Superpowers](https://github.com/obra/superpowers) — Jesse Vincent | MIT | skills that activate on their own; worktree isolation; test before the fix; review before finishing | adapted in `skills/` (spec-workflow, systematic-diagnosis, evidence-gate) and the worktree model; no code copied |
| [Graphify](https://github.com/Graphify-Labs/graphify) — Safi Shamsi and the Graphify contributors | Apache-2.0 (portions MIT) | a local code graph from tree-sitter ASTs with EXTRACTED / INFERRED / AMBIGUOUS edges, plus LLM extraction for documents | **vendored** in `vendor/graphify` with a patch; see below |

## Why these three

Spec Kit makes the specification the unit of work, but it trusts the implementer to report
completion. Superpowers makes good process automatic, but its checks are instructions to one
agent. Graphify gives an agent a map of the code, but a map is not evidence. Claudex needed
all three at once and one thing none of them provides: completion is decided by evidence bound
to the exact snapshot it was taken from — source digest, configuration digest, specification
digest — and a different model reviews what one model produced. Where a provider is absent,
the substitution is recorded and a re-check is owed.

## Who Claudex is for

A single maintainer or a small team who develop with two AI providers (Claude and Codex) on a
real product, want those agents to work in parallel without stepping on each other, and need
to be able to say "done" only when a check, a review and — for an Obsidian plugin — a live
vault observation agree. It is not a general agent framework and it does not host models.

## Vendored Graphify

`vendor/graphify/` is Graphify 0.9.66 (upstream commit `a5957aa`) with one change, recorded in
`vendor/graphify/UPSTREAM.md` and proposed upstream: a document's reference to code in a file
outside its extraction chunk is kept for the graph builder to resolve, instead of being dropped
together with the misattributed node (#1895/#1916). The upstream license, `LICENSE-MIT` and
`NOTICE` are kept beside it. Claudex runs it with the dependencies of a separately installed
Graphify (`uv tool install graphifyy`), builds the graph outside the product repository and
decides which slice a job sees (`docs/how-to/graph.md`). Graphify's own agent hooks are not
installed: they rewrite entry points that Claudex generates and verifies.

## Thanks

To GitHub and the Spec Kit contributors, to Jesse Vincent and the Superpowers contributors,
and to Safi Shamsi and the Graphify contributors — for publishing their work openly, with
licenses that allow it to be studied, adapted and built upon.
