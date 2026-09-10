# Evidence register

This register distinguishes published evidence, local observations and architectural
judgment. A source is authoritative about its own API or experiment; it is not universal
proof that a method improves this harness. Recheck mutable APIs before a release.

Last reviewed: 2026-09-10.

## Research foundations

| ID | Source and version | Supported observation | Claudex decision and limit |
|---|---|---|---|
| R1 | Mert Cemri et al., [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/html/2503.13657v3), v3, 2025-10-26 | MAST separates system design, agent alignment and task verification failures | Test each boundary; do not claim a universal percentage of loss per handoff |
| R2 | Xiangyi Li et al., [SkillsBench](https://arxiv.org/html/2602.12670v4), v4, 2026-06-14 | Paired evaluations show variable benefit from curated skills; focused packages outperform exhaustive ones in the study | Keep a small selected skill set and compare locally; published gains are not a Claudex forecast |
| R3 | Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | Simple composable workflows are a useful starting point | Keep one coordinator and avoid stacking orchestration frameworks |
| R4 | Anthropic, [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Relevant context and retrieval timing matter | Supply bounded packets and load selected skill bodies |
| R5 | Anthropic, [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), 2025-11-26 | Persistent progress artifacts support work across sessions | Store task identity and evidence outside conversation history |
| R6 | Anthropic, [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps), 2026-03-24 | Evaluation and scaffolding need reassessment as models improve | Revisit each component through ablation instead of accumulating rules indefinitely |
| R7 | Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), 2026-01-09 | Agent evaluation must account for outcomes and trajectories | Separate execution evidence, model judgment and acceptance |

## Method influences

Claudex skill text is an original synthesis; complete third-party prompts and scripts are
not copied into the runtime. These links preserve the inspected versions:

- **Debugging and completion discipline:** obra,
  [systematic-debugging](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/systematic-debugging/SKILL.md)
  and [verification-before-completion](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/verification-before-completion/SKILL.md).
  Influence: test a cause and inspect fresh verification before claiming completion.
- **Bounded delegation and continuity:** obra,
  [subagent-driven-development](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills/subagent-driven-development/SKILL.md).
  Influence: explicit task inputs and durable progress. Its complete orchestration loop is not enabled.
- **Behavioral tests through a useful boundary:** Matt Pocock,
  [TDD](https://github.com/mattpocock/skills/blob/3cca18b368ae95cdbdebbff572ccafa662551015/skills/engineering/tdd/SKILL.md).
  Influence: a small behavioral slice. Claudex does not require redundant permission or tests for every cosmetic edit.
- **Evaluate skill changes:** Anthropic,
  [skill-creator](https://github.com/anthropics/skills/blob/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/skill-creator/SKILL.md).
  Influence: compare skill/no-skill runs, activation and total usage. Generating a skill does not qualify it for release.
- **Obsidian domain practices:** kepano,
  [obsidian-skills](https://github.com/kepano/obsidian-skills).
  Influence: use host-specific formats and native CLI operations. The host's documentation remains the command contract.

## Runtime specifications

| Authority | Specification | Revalidate before |
|---|---|---|
| Agent Skills | [Portable skill format](https://agentskills.io/specification) | Changing frontmatter/discovery |
| Anthropic | [CLI reference](https://code.claude.com/docs/en/cli-reference) | Changing restricted mode, tool sets, readiness/result parsing |
| Anthropic | [Programmatic execution](https://code.claude.com/docs/en/headless) | Changing authentication isolation: bare mode skips OAuth; safe mode preserves native authentication |
| OpenAI | [Codex command-line reference](https://developers.openai.com/codex/cli/reference) | Changing exec, sandbox, config isolation or JSON events |
| OpenAI | [Subagents](https://developers.openai.com/codex/subagents) | Changing native role generation or nested-agent policy |
| OpenAI | [Windows sandbox](https://developers.openai.com/codex/windows) | Changing native sandbox implementation or setup prerequisites |
| Obsidian | [CLI](https://obsidian.md/help/cli) | Changing vault selection, commands or evidence capture |
| GitHub | [Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) | Changing server publication enforcement |

## Local engineering basis

The initiating OBS project experienced stale configuration paths, worktrees without local
instructions, reviewers receiving excessive authority, review of obsolete snapshots and
UI success without the promised persistence. Those observations motivate regression tests;
private transcripts, vault contents and credential-bearing configurations are not published.

The `flow-render` method grew from this project: each discrepancy needs a visible-promise
reference and an actual-effect reference. It remains a source-derived hypothesis until
validated in the host. No comparative success rate is claimed for this local method.

## Updating a source or method

Record the source version, changed claim, affected contract and proposed regression test.
For API changes, check the installed binary as well as documentation. For methodology,
compare the repaired minimal baseline with one changed component under matched tasks,
models and budgets. Keep both successful and failed trials. See [validation](validation.md).
