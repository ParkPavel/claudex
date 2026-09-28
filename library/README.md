# Reference library

Worked solutions from other projects, kept as a library to consult, not as skills to load.
Nothing here is generated into `.claude/skills` or `.agents/skills`, nothing is injected
into a job prompt, and nothing here is part of the release archive (`package.json` `files`).
A Claudex skill names the file to read for the task at hand; see
[`skills/native-ui-quality`](../skills/native-ui-quality/SKILL.md).

The library is a reference, not an authority. The Claudex contract, the project profile and
the recorded working principles win over anything here, and every value quoted from it is
checked against the current source or platform documentation before it becomes a decision.

## Contents

| Folder | Source | Pinned commit | License | What it is for |
|---|---|---|---|---|
| `emil/` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | `d16ebe60d09a5ba2afcb7054ede9d0a10c9f6128` | MIT, see `emil/LICENSE` | UI polish, motion, gestures, web-on-phone fixes, Swift |
| `apple-hig/` | [justinwetch/HIGAgentSkills](https://github.com/justinwetch/HIGAgentSkills) | `701151a7b39609b71a58d54de6d86e3500c0c316` | none declared | Apple Human Interface Guidelines, distilled into 156 routed files |

`apple-hig/` carries no license and restates Apple's guidelines; the repository says it is
an independent reference, not affiliated with or endorsed by Apple. It is kept here for
local reference only. Do not publish it with Claudex or quote it at length; link to
[developer.apple.com/design/human-interface-guidelines](https://developer.apple.com/design/human-interface-guidelines)
when a rule is cited in anything public.

## How to read it

- **HIG:** start from `apple-hig/routing-index.md`. Tier 1 (sixteen foundation files) applies
  to any interface; tier 2 names the platform file (`designing-for-ios`, `designing-for-ipados`);
  tier 3 and 4 are loaded by keyword. `apple-hig/SKILL.md` is the source project's own loading
  protocol; follow its tiers, not its instruction to load everything at once.
- **emil:** each folder is one skill with its own `SKILL.md`; some add a reference file
  (`RECIPES.md`, `STANDARDS.md`, `AUDIT.md`). Read the one the task needs.

## Updating

Replace a folder from a newer commit of its source, update the pinned commit above, and read
the diff before committing it: a library change changes what agents will be told is good.
