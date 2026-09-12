import path from 'node:path';
import { assert, atomicJSON, exists, readJSON } from './io.mjs';
import fs from 'node:fs/promises';

// A one-shot permission for one writing task, in the installations that ask for
// one. `approval` is the default access mode for a fresh install: the harness
// can read and reason on its own, and a person says yes before it writes.
//
// The permit is a file, single-use, and consumed by the worker that uses it, so
// an approval cannot be spent twice or inherited by the next task with the same
// name.

export const approvalFile = (ws, taskId) => path.join(ws.state, 'approvals', `${taskId}.json`);

export async function approve(ws, { taskId, reason, actor = 'maintainer', expiresMs = 60 * 60 * 1000 }) {
  assert(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,70}$/.test(taskId || ''), 'Invalid task ID');
  assert(typeof reason === 'string' && reason.trim().length >= 8, 'An approval records why the writer may run, in a sentence a later reader can use');
  const record = { taskId, reason: reason.trim(), actor, issuedAt: new Date().toISOString(), expires: Date.now() + expiresMs };
  await atomicJSON(approvalFile(ws, taskId), record);
  return record;
}

export async function readApproval(ws, taskId) {
  const file = approvalFile(ws, taskId);
  if (!(await exists(file))) return null;
  const record = await readJSON(file);
  return Date.now() < record.expires ? record : { ...record, expired: true };
}

/** Spend the permit. A permit that stays after its job started is a permit for the next one too. */
export async function consume(ws, taskId) {
  const record = await readApproval(ws, taskId);
  if (!record) return null;
  await fs.rm(approvalFile(ws, taskId), { force: true });
  return record;
}

export async function pending(ws) {
  const dir = path.join(ws.state, 'approvals');
  if (!(await exists(dir))) return [];
  const files = (await fs.readdir(dir)).filter(name => name.endsWith('.json'));
  return Promise.all(files.map(async name => {
    const record = await readJSON(path.join(dir, name));
    return { ...record, expired: Date.now() >= record.expires };
  }));
}

/**
 * What this access mode requires of a writing packet. Read-only work is never
 * gated here: the modes differ in what the harness may change, not in what it
 * may look at.
 */
export async function requireWriteAuthority(ws, packet) {
  if (packet.authority !== 'workspace-write') return { access: ws.config.access, approval: null };
  const access = ws.config.access;
  if (access === 'full' || access === 'scoped') return { access, approval: null };
  const record = await readApproval(ws, packet.taskId);
  assert(record, `Access mode "approval": a writer needs an approval for this task. Run: claudex approve ${packet.taskId} --reason "<why>"`);
  assert(!record.expired, `The approval for ${packet.taskId} has expired. Issue a new one when you are ready for the writer to run.`);
  return { access, approval: record };
}
