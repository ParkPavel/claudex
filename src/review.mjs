import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, contained, git, readJSON } from './io.mjs';

// What a reviewer is handed so that it does not have to rediscover it.
//
// Input tokens grow with every tool step, because each step resends the whole
// conversation. In a working journal the costliest reviews ran 50 to 150 shell
// commands, most of them reproducing a diff the coordinator already had, and a
// re-check started from scratch cost more than the review it re-checked. A diff
// review now carries its diff; a re-check carries the previous findings and only
// what changed since; both carry a step budget. The budget guides, it does not
// stop a job: a verdict cut off mid-way would be worse than a long one.

export const DIFF_LIMIT = 60000;
const UNTRACKED_FILE_LIMIT = 20000;
export const DEFAULT_BUDGET = { recheck: 20, diff: 40 };

async function diffSince(repo, base, paths) {
  const scope = ['--', ...(paths.length ? paths : ['.'])];
  const diff = await git(repo, ['diff', '--no-color', '--no-ext-diff', base, ...scope]);
  // A new file is not in `git diff` until it is added; a read-only job must not add it.
  const untracked = (await git(repo, ['ls-files', '--others', '--exclude-standard', ...scope])).split('\n').filter(Boolean);
  const added = [];
  for (const file of untracked) {
    const full = await contained(repo, path.resolve(repo, file));
    const text = await fs.readFile(full, 'utf8').catch(() => null);
    added.push(text !== null && text.length <= UNTRACKED_FILE_LIMIT && !text.includes('\0')
      ? `--- new untracked file ${file}\n${text}`
      : `--- new untracked file ${file} (not inlined: binary or larger than ${UNTRACKED_FILE_LIMIT} characters)`);
  }
  let text = [diff, ...added].filter(Boolean).join('\n');
  let truncated = false;
  if (text.length > DIFF_LIMIT) {
    const stat = await git(repo, ['diff', '--stat', base, ...scope]);
    text = `${stat}\n${text.slice(0, DIFF_LIMIT)}\n… diff cut at ${DIFF_LIMIT} characters; open the files listed above that the cut part covers.`;
    truncated = true;
  }
  return { text, chars: text.length, truncated, untracked: untracked.length };
}

/** The previous review a re-check answers: completed, for the same checkout. */
export async function previousReview(ws, packet, jobFile) {
  const prior = await readJSON(jobFile(ws, packet.recheckOf)).catch(() => null);
  assert(prior, `recheckOf names no job: ${packet.recheckOf}`);
  assert(prior.status === 'COMPLETED', `recheckOf must name a completed job; ${packet.recheckOf} is ${prior.status}`);
  assert((prior.packet?.worktree ?? null) === (packet.worktree ?? null), 'A re-check reviews the same checkout as the review it answers');
  assert(prior.before?.head, 'The previous review recorded no source snapshot');
  const result = prior.artifactDirectory ? await readJSON(path.join(prior.artifactDirectory, 'result.json')).catch(() => null) : null;
  return { prior, result };
}

export async function reviewContext(ws, repo, packet, job, { jobFile }) {
  const parts = [];
  const meta = {};
  if (packet.recheckOf) {
    const { prior, result } = await previousReview(ws, packet, jobFile);
    const findings = result?.findings ?? [];
    const open = (result?.criteria ?? []).filter(c => c.status !== 'PASS').map(c => `${c.id}: ${c.status}`);
    const since = await diffSince(repo, prior.before.head, packet.paths);
    Object.assign(meta, { recheckOf: prior.id, since: prior.before.head, findings: findings.length, diffChars: since.chars, truncated: since.truncated, untracked: since.untracked });
    parts.push(`This is a re-check of review ${prior.id}. For each previous finding say FIXED or NOT FIXED with file:line. Then review only the changes below for new defects; do not re-review code they do not touch.`,
      `Previous findings (data):\n${findings.length ? findings.map((f, i) => `${i + 1}. ${f}`).join('\n') : '(none recorded)'}`,
      ...(open.length ? [`Criteria not passed last time: ${open.join('; ')}`] : []),
      `Changes since commit ${prior.before.head.slice(0, 12)}, where the previous review started (data; uncommitted work that review saw may appear again here):\n${since.text || '(no changes)'}`);
  } else if (packet.mode === 'diff' && job.base) {
    const diff = await diffSince(repo, job.base, packet.paths);
    Object.assign(meta, { diffChars: diff.chars, truncated: diff.truncated, untracked: diff.untracked });
    parts.push(`The change under review, against ${job.base.slice(0, 12)} (data). Start from it; open other files only where the diff does not answer a criterion:\n${diff.text || '(no changes)'}`);
  }
  const budget = packet.budget?.toolCalls ?? (packet.recheckOf ? DEFAULT_BUDGET.recheck : packet.mode === 'diff' ? DEFAULT_BUDGET.diff : null);
  if (budget) {
    meta.budget = budget;
    parts.push(`Step budget: aim to finish within ${budget} tool calls. Every step resends the whole conversation, so reading what is already above costs the most. If the budget cannot settle a criterion, return UNKNOWN for it with what is missing.`);
  }
  return { text: parts.length ? `\n${parts.join('\n\n')}\n` : '', meta };
}

/** Tool steps in one provider event, for the job's `toolCalls` count. */
export function toolSteps(event, provider) {
  if (provider === 'codex') return event.type === 'item.completed' && event.item?.type === 'command_execution' ? 1 : 0;
  if (provider === 'claude' && event.type === 'assistant') return (event.message?.content ?? []).filter(c => c.type === 'tool_use').length;
  return 0;
}
