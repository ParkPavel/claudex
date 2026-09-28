import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, atomicJSON, exists, git, readJSON } from './io.mjs';
import { validatePacket } from './adapters.mjs';
import { validateTaskPacket } from './tasks.mjs';
import { requireWriteAuthority } from './approvals.mjs';
import { listJobs, TERMINAL } from './jobs.mjs';
import { status as modeStatus } from './modes.mjs';

// Claude Code hooks that carry Claudex state across sessions and turns. They
// started as local scripts next to one workspace and kept being forgotten or
// copied with a hard-coded path; here they read the workspace they are given.
//
// Every hook fails open: a broken probe must never stop a session, a turn or a
// tool call. The pre-run gate is a convenience ahead of the boundary, not the
// boundary: it asks the same functions that `run` asks, so it cannot drift from
// them, and a job is checked again when it starts.

export const HOOKS = ['session-start','handoff','pre-run','report-ready'];
const FRESH_MS = 6 * 60 * 60 * 1000;
const MAX_REPORTS = 3;
const MAX_CONTEXT = 2000;
const handoffJournal = ws => path.join(ws.state,'reports','handoff.jsonl');
const seenFile = ws => path.join(ws.state,'reports','.reported-jobs.json');
const quiet = async fn => { try { return await fn(); } catch { return null; } };

async function projectState(ws) {
  const run = async args => (await git(ws.project,args)).trim();
  const trees = (await run(['worktree','list'])).split('\n').filter(Boolean).slice(1);
  return {
    branch: await run(['rev-parse','--abbrev-ref','HEAD']),
    head: (await run(['rev-parse','HEAD'])).slice(0,12),
    dirty: (await run(['status','--porcelain'])).split('\n').filter(Boolean).length,
    trees,
  };
}

/** SessionStart: who answers for which role, what is owed, where the project stands. */
export async function sessionStart(ws) {
  const lines = [];
  try {
    const assigned = Object.entries(ws.config.assignments ?? {}).map(([role,a]) => `${role}=${a.provider ?? 'default'}${a.model ? `/${a.model}` : ''}${a.effort ? `@${a.effort}` : ''}`);
    lines.push(`Claudex: project ${ws.config.project}, profile ${ws.config.profile}, access ${ws.config.access}.`);
    lines.push(`Role assignments: ${assigned.length ? assigned.join(', ') : 'role table defaults'}; codex default model ${ws.config.models?.codex ?? 'unset'}.`);
    const jobs = await listJobs(ws);
    const modes = await modeStatus(ws,jobs);
    const unavailable = Object.entries(modes.providers).filter(([,p]) => p.available === false).map(([name]) => name);
    lines.push(`Provider mode: ${modes.mode}${unavailable.length ? `; unavailable: ${unavailable.join(', ')}` : ''}.`);
    for (const entry of modes.open) lines.push(`OPEN DELEGATION ${entry.id}: ${entry.substitute} answers for ${entry.unavailable} (${entry.roles.join(', ')}). Its verdicts are single-model proposals, not independent review.`);
    for (const debt of modes.debt) lines.push(`RE-CHECK OWED under ${debt.delegation}: ${debt.jobs.map(j => j.taskId).join(', ')}. Settled by re-running at the restored provider, not by closing the delegation.`);
    const active = jobs.filter(job => !TERMINAL.has(job.status));
    if (active.length) lines.push(`Active jobs: ${active.map(job => `${job.taskId} (${job.status})`).join(', ')}. Wait with: claudex wait --timeout-min 40`);
    const state = await projectState(ws);
    lines.push(`Project: ${state.branch} @ ${state.head}, ${state.dirty ? `${state.dirty} uncommitted change(s)` : 'clean tree'}.`);
    if (state.trees.length) lines.push(`Worktrees: ${state.trees.length} — ${state.trees.join(' | ')}.`);
  } catch (error) {
    lines.push(`Claudex state could not be read: ${error.message}. Check with: claudex doctor`);
  }
  const last = await quiet(async () => (await fs.readFile(handoffJournal(ws),'utf8')).trim().split('\n').filter(Boolean).pop());
  if (last) {
    const entry = JSON.parse(last);
    lines.push(`Last handoff (${entry.at}): ${entry.branch} @ ${entry.head}${entry.dirty ? ', tree was dirty' : ''}${entry.worktrees ? `, worktrees: ${entry.worktrees}` : ''}.`);
  }
  return { hookSpecificOutput:{ hookEventName:'SessionStart', additionalContext:lines.join('\n') }, suppressOutput:true };
}

/**
 * Stop / SessionEnd: one line of state, so the next session resumes an exact
 * snapshot instead of the newest conversation. Stop fires every turn, so a line
 * is written only when the state changed; SessionEnd always writes.
 */
export async function handoff(ws, input = {}) {
  await quiet(async () => {
    const event = input.hook_event_name || 'Stop';
    const state = await projectState(ws);
    const approvals = await quiet(async () => (await fs.readdir(path.join(ws.state,'approvals'))).filter(name => name.endsWith('.json')).length) ?? 0;
    const entry = { at:new Date().toISOString(), event, session:input.session_id ?? null, branch:state.branch, head:state.head, dirty:state.dirty, worktrees:state.trees.length, approvals };
    entry.fingerprint = `${entry.branch}:${entry.head}:${entry.dirty}:${entry.worktrees}:${entry.approvals}`;
    const file = handoffJournal(ws);
    const previous = await quiet(async () => JSON.parse((await fs.readFile(file,'utf8')).trim().split('\n').filter(Boolean).pop()).fingerprint);
    if (event === 'SessionEnd' || entry.fingerprint !== previous) {
      await fs.mkdir(path.dirname(file),{recursive:true});
      await fs.appendFile(file,`${JSON.stringify(entry)}\n`);
    }
  });
  return { suppressOutput:true };
}

/**
 * PreToolUse(Bash): a writing packet about to be run is checked by the same
 * validation `run` performs, and refused early with the commands that fix it.
 */
export async function preRun(ws, input = {}) {
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return null;
  const match = command.match(/claudex\.mjs["']?\s+run\s+("[^"]+"|'[^']+'|[^\s"';&|]+)/);
  if (!match) return null;
  const file = path.resolve(input.cwd ?? ws.root, match[1].replace(/^["']|["']$/g,''));
  const packet = await quiet(() => readJSON(file));
  // claudex reports a missing or unreadable packet better than a hook can.
  if (!packet || packet.authority !== 'workspace-write') return null;
  const problems = [];
  const fix = [];
  try { await validatePacket(packet); } catch (error) { problems.push(error.message); }
  if (packet.worktree && !(await exists(path.resolve(ws.root,packet.worktree)))) problems.push(`Worktree ${packet.worktree} does not exist`);
  if (!packet.worktree || problems.some(p => /worktree/i.test(p))) fix.push(`claudex worktree ${packet.taskId} --base HEAD --paths ${(packet.paths ?? []).join(',') || '<paths>'}  (then put the printed path in the packet's "worktree")`);
  try { await validateTaskPacket(ws,packet); } catch (error) { problems.push(error.message); if (/contract/i.test(error.message)) fix.push(`claudex task init ${packet.taskId} --goal "<goal>" --worktree <path>, then claudex task check ${packet.taskId}`); }
  try { await requireWriteAuthority(ws,packet); } catch (error) { problems.push(error.message); if (/approv/i.test(error.message)) fix.push(`claudex approve ${packet.taskId} --reason "<why this writer may run>"`); }
  if (!problems.length) return null;
  const reason = `The writing job ${packet.taskId} (${packet.role}) is not ready:\n- ${[...new Set(problems)].join('\n- ')}${fix.length ? `\n\nFix with:\n  ${[...new Set(fix)].join('\n  ')}` : ''}`;
  return { hookSpecificOutput:{ hookEventName:'PreToolUse', permissionDecision:'deny', permissionDecisionReason:reason } };
}

function summarise(job, result, postmortem) {
  if (!result) {
    if (!postmortem) return job.error ? `  ${String(job.error).slice(0,200)}` : '  (no result)';
    const who = postmortem.provider ? `${postmortem.provider.provider}/${postmortem.provider.model ?? '?'}` : 'provider unknown';
    return [
      `  stopped at ${postmortem.failure?.stage ?? '?'} (${who}): ${String(postmortem.failure?.error ?? postmortem.failure?.providerError ?? 'no error text').slice(0,200)}`,
      ...(postmortem.nextChecks ?? []).slice(0,3).map(line => `  - ${String(line).slice(0,200)}`),
    ].join('\n');
  }
  const verdicts = (result.criteria ?? []).map(c => `${c.id}:${c.status}`).join(', ');
  // The schema defines findings as defects, so they come first. A FAIL with no
  // findings is the older shape, where defects were filed as criterion evidence.
  const findings = (result.findings ?? []).slice(0,4).map(f => `  - ${String(f).slice(0,200)}`);
  const failing = findings.length ? [] : (result.criteria ?? []).filter(c => c.status === 'FAIL').flatMap(c => (c.evidence ?? []).slice(0,3).map(e => `  ! ${c.id}: ${String(e).slice(0,200)}`));
  const gaps = job.resultGaps?.missing?.length ? [`  no answer for: ${job.resultGaps.missing.join(', ')}`] : [];
  return [verdicts ? `  verdicts: ${verdicts}` : '', ...findings, ...failing.slice(0,4), ...gaps].filter(Boolean).join('\n');
}

/**
 * A finished job's verdict reaches the model once, with the person's next
 * prompt. Stop's additionalContext would not wait for that: per the hooks
 * reference it continues the conversation (up to eight times), buying model
 * turns nobody asked for. So at Stop the person only sees a notice, nothing is
 * marked seen, and UserPromptSubmit carries the reports as context. Backlog
 * older than six hours is history, not news, and is marked seen silently.
 *
 * Each session keeps its own ledger, so a report reaches every session that
 * is working, not whichever prompt came first. Known limit: a prompt that
 * another hook blocks is never sent, and a hook cannot learn that; its
 * reports stay readable through `wait` and `status`.
 */
// One file per session: two sessions never rewrite the same file, so neither
// can erase what the other recorded. Only IDs inside the freshness window are
// kept (older jobs are filtered out anyway), and a session file untouched for a
// week is removed, so the ledger stays small however long the workspace lives.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessionDir = ws => path.join(ws.state,'reports','seen');
const sessionFile = (ws, session) => path.join(sessionDir(ws), `${/^[\w-]{1,80}$/.test(session) ? session : crypto.createHash('sha256').update(session).digest('hex').slice(0,32)}.json`);
async function readSeen(ws, session) {
  // An earlier version kept one list for the whole workspace; it still counts for every session.
  const legacy = await quiet(() => readJSON(seenFile(ws)));
  const own = await quiet(() => readJSON(sessionFile(ws,session)));
  return new Set([...(Array.isArray(legacy) ? legacy : []), ...(Array.isArray(own) ? own : [])]);
}
async function writeSeen(ws, session, seen, jobs, now) {
  const fresh = new Set(jobs.filter(job => !(now - Date.parse(job.updated ?? job.created ?? 0) > FRESH_MS)).map(job => job.id));
  await fs.mkdir(sessionDir(ws),{recursive:true});
  await atomicJSON(sessionFile(ws,session),[...seen].filter(id => fresh.has(id)));
  for (const name of await quiet(() => fs.readdir(sessionDir(ws))) ?? []) {
    const file = path.join(sessionDir(ws),name);
    const stat = await quiet(() => fs.stat(file));
    if (stat && now - stat.mtimeMs > SESSION_TTL_MS) await quiet(() => fs.rm(file,{force:true}));
  }
}
export async function reportReady(ws, { now = Date.now(), event = 'UserPromptSubmit', session = 'default' } = {}) {
  if (event === 'Stop') {
    const seen = await readSeen(ws,session);
    const waiting = (await listJobs(ws)).filter(job => TERMINAL.has(job.status) && !seen.has(job.id) && !(now - Date.parse(job.updated ?? job.created ?? 0) > FRESH_MS));
    return waiting.length ? { systemMessage:`Claudex: ${waiting.length} job report(s) ready; they reach Claude with your next message.`, suppressOutput:true } : null;
  }
  return deliverReports(ws, now, session);
}
async function deliverReports(ws, now, session) {
  const seen = await readSeen(ws,session);
  const jobs = await listJobs(ws);
  const ready = [];
  for (const job of [...jobs].sort((a,b) => String(a.updated ?? '').localeCompare(String(b.updated ?? '')))) {
    if (!TERMINAL.has(job.status) || seen.has(job.id)) continue;
    const finished = Date.parse(job.updated ?? job.created ?? 0);
    // Backlog is marked seen silently; a fresh report is marked only once shown.
    if (Number.isFinite(finished) && now - finished > FRESH_MS) { seen.add(job.id); continue; }
    ready.push(job);
  }
  // Oldest first, as many as fit: a report is marked seen only when its block is
  // in the delivered text; the rest wait for the next prompt. A summary too long
  // for the limit is cut, but the status line and the path to the full result
  // always survive, so a delivered report can always be read in full.
  const blocks = [];
  let used = 0;
  const budget = MAX_CONTEXT - 200;
  for (const job of ready.slice(0,MAX_REPORTS)) {
    const dir = job.artifactDirectory ?? path.join(ws.state,'artifacts',job.id);
    const result = await quiet(() => readJSON(path.join(dir,'result.json')));
    const postmortem = await quiet(() => readJSON(path.join(dir,'postmortem.json')));
    const head = `${job.taskId} -> ${job.status}`;
    const tail = `  full result: ${path.join(dir,postmortem && !result ? 'postmortem.json' : 'result.json')}`;
    let body = summarise(job,result,postmortem);
    const room = budget - used - head.length - tail.length - 2;
    if (body.length > room) {
      if (blocks.length) break;
      body = `${body.slice(0,Math.max(0,room - 40))}\n  … cut; read the full result`;
    }
    const block = `${head}\n${body}\n${tail}`;
    blocks.push(block);
    used += block.length + 1;
    seen.add(job.id);
  }
  await writeSeen(ws,session,seen,jobs,now);
  if (!blocks.length) return null;
  const text = `Claudex: reports ready (${blocks.length} of ${ready.length}${ready.length > blocks.length ? '; the rest follow with the next prompt' : ''}):\n${blocks.join('\n')}`;
  return { suppressOutput:true, hookSpecificOutput:{ hookEventName:'UserPromptSubmit', additionalContext:text } };
}

export async function runHook(ws, name, input = {}) {
  if (name === 'session-start') return sessionStart(ws);
  if (name === 'handoff') return handoff(ws,input);
  if (name === 'pre-run') return preRun(ws,input);
  if (name === 'report-ready') return reportReady(ws,{ event:input.hook_event_name === 'Stop' ? 'Stop' : 'UserPromptSubmit', session:String(input.session_id ?? 'default') });
  throw new Error(`Unknown hook ${name}; one of ${HOOKS.join(', ')}`);
}

/**
 * The hook block for .claude/settings.local.json. The generated settings.json
 * is hash-checked by sync, so hooks live in the local layer; installing merges
 * into whatever that file already holds and replaces only earlier Claudex
 * entries, recognised by the command they run.
 */
// Exec form: `command` is spawned with `args` and no shell, so a workspace path
// holding $() or backticks is a path, not a command. The same form runs under
// Git Bash and PowerShell, and the gate matches both shell tools.
export function hookSettings(ws) {
  const cli = path.join(ROOT,'bin','claudex.mjs');
  const hook = (name, extra = {}) => ({ type:'command', command:process.execPath, args:[cli,'hook',name,'--workspace',ws.root], ...extra });
  return {
    SessionStart:[{ hooks:[hook('session-start',{ timeout:20, statusMessage:'Reading Claudex state' })] }],
    SessionEnd:[{ hooks:[hook('handoff',{ timeout:20 })] }],
    Stop:[{ hooks:[hook('handoff',{ timeout:20, async:true }), hook('report-ready',{ timeout:15 })] }],
    UserPromptSubmit:[{ hooks:[hook('report-ready',{ timeout:15 })] }],
    PreToolUse:[{ matcher:'Bash|PowerShell', hooks:[hook('pre-run',{ timeout:15 })] }],
  };
}
const HOOK_NAME = /^(session-start|handoff|pre-run|report-ready)$/;
const isOurs = hook => (Array.isArray(hook.args) && hook.args.some(a => /claudex\.mjs$/.test(String(a))) && hook.args.some(a => HOOK_NAME.test(String(a))))
  || / hook (session-start|handoff|pre-run|report-ready)\b/.test(hook.command ?? '')
  || /claudex[\\/]hooks[\\/][\w-]+\.mjs/.test(hook.command ?? '');
/** Removes only Claudex's own hooks; an entry keeps its other hooks, and goes only when it holds nothing else. */
export function mergeHookSettings(current, wanted) {
  const hooks = { ...(current.hooks ?? {}) };
  for (const [event, entries] of Object.entries(wanted)) {
    const kept = (hooks[event] ?? []).map(entry => ({ ...entry, hooks:(entry.hooks ?? []).filter(hook => !isOurs(hook)) })).filter(entry => entry.hooks.length);
    hooks[event] = [...kept, ...entries];
  }
  return { ...current, hooks };
}
export async function installHooks(ws) {
  const file = path.join(ws.root,'.claude','settings.local.json');
  const current = (await exists(file)) ? await readJSON(file) : {};
  const next = mergeHookSettings(current,hookSettings(ws));
  await fs.mkdir(path.dirname(file),{recursive:true});
  await atomicJSON(file,next);
  return { file, events:Object.keys(hookSettings(ws)) };
}
