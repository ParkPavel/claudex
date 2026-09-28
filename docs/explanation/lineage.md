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

## Later sources

Studied in a 2026-09-28 improvement session, to solve Claudex's own recorded problems with
examples from similar projects rather than to add another mechanism for pulling in outside code.

| Source | License | What Claudex takes | How |
|---|---|---|---|
| [Spec Kit](https://github.com/github/spec-kit) `analyze` / `clarify` | MIT | a consistency pass over the specification before implementation; asking what only the person can decide | deterministic warnings in `task check` (`analyzeContract`); the spec-workflow skill records such answers as decisions; no code copied |
| [prompt-agent](https://github.com/kvyb/prompt-agent) — kvyb | see repository | scoring past sessions by efficiency, goal, tool correctness and failure points | `claudex retro` over the job journal; no code copied |
| [skills](https://github.com/emilkowalski/skills) — Emil Kowalski | MIT | design engineering, motion, gestures, web-on-phone fixes, Swift | **copied** into `library/emil` with its license, read through the `native-ui-quality` skill |
| [HIGAgentSkills](https://github.com/justinwetch/HIGAgentSkills) — Justin Wetch | none declared | Apple HIG distilled into 156 files with a tiered routing index | kept as a local reference in `library/apple-hig`; the routing idea shapes `native-ui-quality` |
| [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines) | Apple | the quality bar itself | cited as the primary source; not redistributed |
| [Claude Code hooks](https://code.claude.com/docs/en/hooks) | documentation | exec-form hooks, the `Bash\|PowerShell` matcher, Stop context semantics | `claudex hook` and `hooks --install` |

Evaluated and not integrated: the [TypeSafe agent skill](https://docs.typesafe.ai/agent-skill)
and its Jev model (typed Choice / Score / Noul answers with probabilities). It could advise on
routing and finding triage, but it is an external service and was judged not yet reliable
enough to sit in the job path.

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

`vendor/graphify/` is Graphify 0.9.66 (upstream commit `a5957aa`) with two changes, recorded in
`vendor/graphify/UPSTREAM.md` and proposed upstream: a document's reference to code in a file
outside its extraction chunk is kept for the graph builder to resolve, instead of being dropped
together with the misattributed node (#1895/#1916); and on Windows the PYTHONHASHSEED re-exec
runs as a child process, because the emulated exec through a venv launcher crashed with no output. The upstream license, `LICENSE-MIT` and
`NOTICE` are kept beside it. Claudex runs it with the dependencies of a separately installed
Graphify (`uv tool install graphifyy`), builds the graph outside the product repository and
decides which slice a job sees (`docs/how-to/graph.md`). Graphify's own agent hooks are not
installed: they rewrite entry points that Claudex generates and verifies.

## Thanks

To GitHub and the Spec Kit contributors, to Jesse Vincent and the Superpowers contributors,
to Safi Shamsi and the Graphify contributors, to Emil Kowalski, to Justin Wetch and to kvyb —
for publishing their work openly, so that it can be studied, adapted and built upon.
