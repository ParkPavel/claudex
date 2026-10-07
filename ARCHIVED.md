# Claudex went into the borshch

**English** · [Русский](ARCHIVED.ru.md)

> **Status: ARCHIVED** · 2026-10-07 · 1.1.0 is the last version.
> It continues as **[Borshkit](https://github.com/ParkPavel/borshkit)**.

Claudex was a good piece of meat. It was cooked to the right
[doneness](https://en.wikipedia.org/wiki/Doneness), browned through the
[Maillard reaction](https://en.wikipedia.org/wiki/Maillard_reaction) and lowered into the pot.
It is now an ingredient of the [borshch](https://en.wikipedia.org/wiki/Borscht) simmering in
[Borshkit](https://github.com/ParkPavel/borshkit). The meat is no longer served on its own.

---

## Review of the reasons for archiving

Written the way Claudex itself accepted work: every claim is a criterion, every criterion has a
verdict and evidence. Whatever is not shown stays `UNKNOWN` and never becomes `PASS` by default.
Not even at its own funeral.

```text
$ claudex task converge archive-claudex
```

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | The meat is cooked: the ideas were proven in use, not on a napkin | `PASS` | 1.0.0 went through seven cross-model review rounds, the last with no P1 or P2; behind it, a working journal of 202 jobs ([CHANGELOG](CHANGELOG.md)) |
| 2 | The meat gave the broth its best | `PASS` | Task contracts, snapshot-bound evidence, review by another executor and an honest "not verified" live on in Borshkit — see [the recipe](#where-everything-went) |
| 3 | Two pots of the same recipe on one stove are not needed | `PASS` | Maintaining two harnesses around one idea means salting twice and over-salting twice |
| 4 | The name got too tight | `PASS` | "Claude + Codex" is about two cooks. Borshch is cooked by any agent in any project: web app, plugin, library, mobile app, research |
| 5 | The project is closed because it did not work | `FAIL` | It worked. It is closed because it was useful — you don't throw meat away, you eat it |
| 6 | Someone needs plain Claudex | `UNKNOWN` | No evidence. If that is you — the code is Apache-2.0 and nobody forbids a fork |

**Result:** archiving is justified on every criterion that can be checked; criterion 5 is refuted
by evidence and criterion 6 is honestly left `UNKNOWN`. The meat is done; the pot is waiting.

## Where everything went

The recipe as of the [Borshkit README](https://github.com/ParkPavel/borshkit#readme) at the time
of archiving (0.11.1). The cook may change the recipe — check the pot.

| In Claudex | In the borshch |
|---|---|
| `task init` · `task check` · `task converge` — a contract and a verdict per criterion | Task goal and criteria, an acceptance sheet |
| Evidence bound to source, configuration and specification digests | Every proof is bound to the exact state of the files |
| Read-only review by the other provider's model | Review by another executor |
| `UNKNOWN` never becomes `PASS` | What is not verified is called exactly that: **not verified** |
| A separate `worktree` for every writer | An agent works in its own copy of the project |
| Claude Code hooks (`claudex hook …`) | A Claude Code plugin with guard hooks |

## Moving over

```text
/plugin marketplace add ParkPavel/borshkit
/plugin install borshkit@borshkit
```

Or as a terminal command:

```sh
git clone https://github.com/ParkPavel/borshkit.git
cd borshkit && npm link        # adds the borshkit and borsch commands
```

This repository promises nothing about moving Claudex's local state (`.claudex`, job journals,
contracts). Check the Borshkit documentation for what it can take along.

## What stays here

- Code, tags and history stay as they are. The [Apache-2.0](LICENSE) license still applies.
- 1.1.0 is the last version. It works, but it goes on without us.
- Issues, pull requests and vulnerability reports are no longer accepted or fixed here — take
  them to [Borshkit](https://github.com/ParkPavel/borshkit/issues).

## Useful and less useful links

- 🍲 [The pot](https://github.com/ParkPavel/borshkit) — where the meat is now.
- 📜 [The recipe](https://github.com/ParkPavel/borshkit#readme) — Borshkit's README.
- 🧂 [Complain about the salt](https://github.com/ParkPavel/borshkit/issues) — Borshkit issues.
- 🔥 [Why the crust tastes good](https://en.wikipedia.org/wiki/Maillard_reaction) — the Maillard reaction.
- 🥩 [Doneness](https://en.wikipedia.org/wiki/Doneness) — Claudex: *well done*.
- 🫕 [What borshch is](https://en.wikipedia.org/wiki/Borscht) — for anyone who somehow doesn't know.
- 📣 [The cook's channel](https://t.me/parkpavel_chigon) — the author's Telegram.

---

<sub>Sour cream to taste. Rye bread. Garlic is not optional. The borshch is judged by whoever
eats it, not by whoever said "done".</sub>
