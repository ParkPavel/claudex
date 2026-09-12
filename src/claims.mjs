import path from 'node:path';
import { assert, atomicJSON, exists, readJSON, withLock } from './io.mjs';

// Who is currently working on which files.
//
// Three tasks once rewrote the same six documents from the same base, in three
// worktrees, and none of them could have known about the others: a packet
// declares `paths`, and nothing ever compared one declaration with another.
// A claim is that comparison. It is a warning system, not a lock — the paths
// are written by the coordinator and can be coarse or wrong — but a coarse
// warning arrives before the work, and a merge conflict arrives after it.

const EMPTY = { schemaVersion: 1, claims: [] };
export const claimsFile = ws => path.join(ws.state, 'claims.json');

export const normalise = value => String(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/** Two scopes touch when either contains the other; `docs` covers `docs/api.md`. */
export function overlaps(left, right) {
  const a = normalise(left);
  const b = normalise(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export async function readClaims(ws) {
  const file = claimsFile(ws);
  if (!(await exists(file))) return structuredClone(EMPTY);
  const state = await readJSON(file);
  assert(state.schemaVersion === 1, 'Unsupported claim state; inspect claims.json before continuing');
  return state;
}

export function conflictsWith(state, paths, { ignore = null } = {}) {
  const wanted = paths.map(normalise);
  const found = [];
  for (const claim of state.claims) {
    if (ignore && claim.id === ignore) continue;
    const touching = claim.paths.filter(claimed => wanted.some(want => overlaps(want, claimed)));
    if (touching.length) found.push({ ...claim, touching });
  }
  return found;
}

/**
 * Register a scope. `overlap` is the escape hatch: a person may decide that two
 * tasks over the same files are intended, and then the reason is recorded on
 * the claim rather than left to be reconstructed later from three branches.
 */
export async function claim(ws, { id, owner, ref, paths, overlap = null }) {
  assert(id && owner && ref, 'A claim needs an id, an owner kind and a reference');
  assert(['job', 'worktree'].includes(owner), 'A claim is owned by a job or a worktree');
  assert(Array.isArray(paths) && paths.length && paths.every(item => typeof item === 'string' && item.trim()), 'A claim needs at least one path');
  return withLock(ws.state, async () => {
    const state = await readClaims(ws);
    // A claim never conflicts with the record it replaces.
    const conflicts = conflictsWith(state, paths, { ignore: id });
    if (conflicts.length) {
      assert(typeof overlap === 'string' && overlap.trim().length >= 8, `Scope already claimed by ${conflicts.map(item => `${item.ref} (${item.touching.join(', ')})`).join('; ')}. Release it, or record why the overlap is intended.`);
    }
    // Re-claiming under the same id replaces the previous record: a worktree
    // reserves its scope by branch name and then records the path it got.
    state.claims = state.claims.filter(entry => entry.id !== id);
    const record = { id, owner, ref, paths: paths.map(normalise), openedAt: new Date().toISOString(), overlap: overlap?.trim() ?? null };
    state.claims.push(record);
    await atomicJSON(claimsFile(ws), state);
    return record;
  });
}

/** Release whatever a path or branch was holding: a retired worktree owns nothing. */
export async function releaseFor(ws, references) {
  const wanted = new Set(references.filter(Boolean).map(normalise));
  return withLock(ws.state, async () => {
    const state = await readClaims(ws);
    const kept = state.claims.filter(entry => !wanted.has(normalise(entry.id)) && !wanted.has(normalise(entry.ref)));
    const released = state.claims.length - kept.length;
    if (released) { state.claims = kept; await atomicJSON(claimsFile(ws), state); }
    return { released };
  });
}

export async function release(ws, id) {
  return withLock(ws.state, async () => {
    const state = await readClaims(ws);
    const before = state.claims.length;
    state.claims = state.claims.filter(entry => entry.id !== id);
    if (before !== state.claims.length) await atomicJSON(claimsFile(ws), state);
    return { id, released: before !== state.claims.length };
  });
}

/** Claims whose owner is gone: a finished job or a worktree that no longer exists. */
export function stale(state, { liveJobs, livePaths }) {
  return state.claims.filter(entry => (entry.owner === 'job' ? !liveJobs.has(entry.ref) : !livePaths.has(normalise(entry.ref))));
}
