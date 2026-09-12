import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, assert, atomicJSON, exists, readJSON, withLock } from './io.mjs';

// A provider can run out of quota mid-task. The remaining provider may then take
// the absent one's roles, but only through a recorded act: who was unavailable,
// who answered instead, which roles moved, why, and which jobs were produced
// that way. Those jobs owe a re-check once the absent provider returns, and the
// debt outlives closing the delegation. Nothing here is inferred: a model cannot
// delegate to itself, and an uncovered unavailable provider fails the job with an
// instruction rather than quietly answering as somebody else.
export const PROVIDERS = ['claude', 'codex'];
const EMPTY = { schemaVersion: 1, providers: {}, open: [], history: [] };
export const delegationFile = ws => path.join(ws.state, 'delegation.json');
export const roleTable = async () => readJSON(path.join(ROOT, 'config/roles.json'));
export const mode = state => (state.open.length ? 'single-model' : 'dual-model');
export const openFor = (state, role) => state.open.find(entry => entry.roles.includes(role)) || null;
export const providerState = (state, provider) => state.providers[provider] || { available: true };

export async function readDelegation(ws) {
  const file = delegationFile(ws);
  if (!(await exists(file))) return structuredClone(EMPTY);
  const state = await readJSON(file);
  assert(state.schemaVersion === 1, 'Unsupported delegation state; inspect delegation.json before continuing');
  for (const key of ['providers', 'open', 'history']) assert(state[key], `Malformed delegation state: missing ${key}`);
  return state;
}

/**
 * `codex>claude` reads well and, in a shell, is a redirect. `codex:claude` means
 * the same thing and survives being typed without quotes, so both are accepted.
 */
export function parseDelegationSpec(spec) {
  const parts = String(spec ?? '').split(/[>:]/).map(part => part.trim()).filter(Boolean);
  assert(parts.length === 2, 'Use --delegate <unavailable>:<substitute>, for example codex:claude (quote it to write codex>claude)');
  return { unavailable: parts[0], substitute: parts[1] };
}

export async function rolesOf(provider) {
  return Object.entries(await roleTable()).filter(([, role]) => role.provider === provider).map(([name]) => name);
}

function reasoned(reason) {
  assert(typeof reason === 'string' && reason.trim().length >= 8, 'Record why the provider is unavailable, in a sentence a later reader can use');
  return reason.trim();
}

/** Mark a provider unavailable without substituting anyone. Its roles then fail fast. */
export async function markUnavailable(ws, { provider, reason, actor = 'maintainer' }) {
  assert(PROVIDERS.includes(provider), 'Unknown provider');
  const text = reasoned(reason);
  return withLock(ws.state, async () => {
    const state = await readDelegation(ws);
    assert(!state.open.some(entry => entry.substitute === provider), `${provider} is substituting for another provider; restore that delegation first`);
    state.providers[provider] = { available: false, reason: text, since: new Date().toISOString(), actor };
    await atomicJSON(delegationFile(ws), state);
    return { provider, ...state.providers[provider] };
  });
}

export async function delegate(ws, { unavailable, substitute, reason, roles = null, actor = 'maintainer' }) {
  assert(PROVIDERS.includes(unavailable) && PROVIDERS.includes(substitute), 'Unknown provider');
  assert(unavailable !== substitute, 'A provider cannot substitute for itself');
  const text = reasoned(reason);
  const table = await roleTable();
  const owned = await rolesOf(unavailable);
  const moving = roles ?? owned;
  assert(moving.length, `${unavailable} owns no roles to delegate`);
  for (const name of moving) {
    assert(owned.includes(name), `Role ${name} does not belong to ${unavailable}`);
    // Substitution never widens authority. The read-only adapter refuses write
    // work anyway; refusing here says so before a job is queued.
    assert(!(substitute === 'codex' && table[name].authority !== 'read-only'), `Role ${name} requires ${table[name].authority}; codex serves read-only roles only`);
  }
  return withLock(ws.state, async () => {
    const state = await readDelegation(ws);
    assert(!state.open.some(entry => entry.unavailable === unavailable), `${unavailable} already has an open delegation`);
    assert(!state.open.some(entry => entry.unavailable === substitute), `${substitute} is itself unavailable; a chain of substitutes hides who actually answered`);
    const taken = state.open.flatMap(entry => entry.roles);
    for (const name of moving) assert(!taken.includes(name), `Role ${name} is already delegated`);
    const record = { id: `delegation-${crypto.randomUUID()}`, unavailable, substitute, roles: moving, reason: text, actor, openedAt: new Date().toISOString(), recheck: 'OWED', jobs: [] };
    state.providers[unavailable] = { available: false, reason: text, since: record.openedAt, actor };
    state.open.push(record);
    await atomicJSON(delegationFile(ws), state);
    return record;
  });
}

/** The provider is back. Closing returns its roles; it does not pay the re-check debt. */
export async function restore(ws, { provider, note = null }) {
  assert(PROVIDERS.includes(provider), 'Unknown provider');
  return withLock(ws.state, async () => {
    const state = await readDelegation(ws);
    const index = state.open.findIndex(entry => entry.unavailable === provider);
    const marked = Object.hasOwn(state.providers, provider);
    assert(index >= 0 || marked, `${provider} is not marked unavailable`);
    delete state.providers[provider];
    let closed = null;
    if (index >= 0) {
      closed = { ...state.open[index], closedAt: new Date().toISOString(), note };
      // Nothing ran under the delegation, so nothing is owed. Saying that is
      // honest; leaving a permanent debt for an unused delegation is not.
      if (!closed.jobs.length) closed.recheck = 'NONE';
      state.open.splice(index, 1);
      state.history.push(closed);
    }
    await atomicJSON(delegationFile(ws), state);
    return { provider, closed, mode: mode(state) };
  });
}

/** Settle the debt: the restored provider has re-checked the delegated work. */
export async function settle(ws, { id, evidence }) {
  const references = (Array.isArray(evidence) ? evidence : String(evidence || '').split(',')).map(item => String(item).trim()).filter(Boolean);
  assert(references.length, 'Settling a re-check needs at least one evidence reference');
  return withLock(ws.state, async () => {
    const state = await readDelegation(ws);
    assert(!state.open.some(entry => entry.id === id), 'This delegation is still open; restore the provider before settling its debt');
    const record = state.history.find(entry => entry.id === id);
    assert(record, `Unknown delegation ${id}`);
    assert(record.recheck === 'OWED', `Delegation ${id} owes no re-check (${record.recheck})`);
    record.recheck = 'SETTLED';
    record.settledAt = new Date().toISOString();
    record.evidence = references;
    await atomicJSON(delegationFile(ws), state);
    return record;
  });
}

export async function recordJob(ws, id, jobId) {
  return withLock(ws.state, async () => {
    const state = await readDelegation(ws);
    const record = state.open.find(entry => entry.id === id);
    if (!record) return null;
    if (!record.jobs.includes(jobId)) record.jobs.push(jobId);
    await atomicJSON(delegationFile(ws), state);
    return record;
  });
}

/**
 * Which provider answers for this role right now. A delegated role runs on the
 * substitute and carries the stamp; an unavailable provider with no delegation
 * refuses instead of running.
 */
export async function resolve(ws, name, role) {
  const state = await readDelegation(ws);
  const entry = openFor(state, name);
  if (entry) return { role: { ...role, provider: entry.substitute }, delegation: { id: entry.id, from: entry.unavailable, to: entry.substitute, role: name, reason: entry.reason } };
  const provider = providerState(state, role.provider);
  assert(provider.available, `${role.provider} is marked unavailable (${provider.reason}). Delegate its roles or restore it before running ${name}.`);
  return { role, delegation: null };
}

/** Jobs produced under a delegation that still owes a re-check. Pure: jobs come from the caller. */
export function debtFromJobs(state, jobs) {
  const byId = new Map(jobs.map(job => [job.id, job]));
  return [...state.open, ...state.history]
    .filter(entry => entry.recheck === 'OWED' && entry.jobs.length)
    .map(entry => ({
      delegation: entry.id,
      answeredBy: entry.substitute,
      insteadOf: entry.unavailable,
      reason: entry.reason,
      state: state.open.some(open => open.id === entry.id) ? 'OPEN' : 'CLOSED',
      jobs: entry.jobs.map(jobId => {
        const job = byId.get(jobId);
        return { jobId, taskId: job?.taskId ?? null, role: job?.packet?.role ?? null, status: job?.status ?? 'UNKNOWN', proposedAcceptance: job?.proposedAcceptance ?? null };
      }),
    }));
}

export async function status(ws, jobs = []) {
  const state = await readDelegation(ws);
  const providers = {};
  for (const provider of PROVIDERS) providers[provider] = providerState(state, provider);
  return { mode: mode(state), providers, open: state.open, history: state.history, debt: debtFromJobs(state, jobs) };
}

const WIDTH = 74;
const row = text => `│ ${text.padEnd(WIDTH - 4)} │`;
const rule = (left, right) => `${left}${'─'.repeat(WIDTH - 2)}${right}`;

/** The modal, as a terminal can draw one: one frame, current state, the acts available. */
export function panel(report) {
  const lines = [rule('┌', '┐'), row(`Claudex modes — ${report.mode}`), row('')];
  for (const [provider, info] of Object.entries(report.providers)) {
    lines.push(row(`${provider.padEnd(8)}${info.available ? 'available' : `unavailable — ${info.reason}`}`.slice(0, WIDTH - 4)));
  }
  lines.push(row(''));
  lines.push(row(report.open.length ? 'Open delegations' : 'No delegation open: each provider answers for its own roles'));
  for (const entry of report.open) {
    lines.push(row(` ${entry.unavailable} → ${entry.substitute} · ${entry.roles.length} roles · ${entry.jobs.length} jobs · re-check ${entry.recheck}`));
    lines.push(row(`   ${entry.id}`));
  }
  const owed = report.debt.reduce((total, item) => total + item.jobs.length, 0);
  lines.push(row(''));
  lines.push(row(owed ? `Re-check debt: ${owed} job(s) answered by a substitute` : 'Re-check debt: none'));
  for (const item of report.debt) lines.push(row(` ${item.delegation} — ${item.answeredBy} instead of ${item.insteadOf} (${item.state})`));
  lines.push(rule('├', '┤'));
  lines.push(row('[d] delegate   [u] mark unavailable   [r] restore'));
  lines.push(row('[s] settle a re-check   [q] close this window'));
  lines.push(rule('└', '┘'));
  return lines.join('\n');
}

/**
 * Drive the modal. `io` supplies write/question so the loop is exercised by tests
 * without a terminal; `listJobs` is injected to keep this module free of the job
 * runner.
 */
export async function interactive(ws, io, listJobs) {
  const acts = [];
  while (true) {
    io.write(`${panel(await status(ws, await listJobs(ws)))}\n`);
    const choice = (await io.question('action> ')).trim().toLowerCase();
    if (!choice || choice === 'q') return { acts };
    try {
      if (choice === 'd') {
        const unavailable = (await io.question('provider that ran out: ')).trim();
        const substitute = (await io.question('provider taking its roles: ')).trim();
        const reason = await io.question('reason (recorded): ');
        acts.push({ act: 'delegate', record: await delegate(ws, { unavailable, substitute, reason }) });
      } else if (choice === 'u') {
        const provider = (await io.question('provider to mark unavailable: ')).trim();
        const reason = await io.question('reason (recorded): ');
        acts.push({ act: 'unavailable', record: await markUnavailable(ws, { provider, reason }) });
      } else if (choice === 'r') {
        const provider = (await io.question('provider that is back: ')).trim();
        const note = (await io.question('note (optional): ')).trim() || null;
        acts.push({ act: 'restore', record: await restore(ws, { provider, note }) });
      } else if (choice === 's') {
        const id = (await io.question('delegation id: ')).trim();
        const evidence = await io.question('evidence references (comma separated): ');
        acts.push({ act: 'settle', record: await settle(ws, { id, evidence }) });
      } else io.write('Unknown action.\n');
    } catch (error) { io.write(`Refused: ${error.message}\n`); }
  }
}
