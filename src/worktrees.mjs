import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, exists, git } from './io.mjs';
import { runCommand } from './process.mjs';

// What is actually happening inside each worktree, and how to retire one
// without taking the shared dependency installation with it.
//
// Both halves come from the same session: a worktree sat mid-merge with six
// conflicts and another held an uncommitted rewrite, while `doctor` reported a
// healthy workspace, because it had never been taught that worktrees exist.
// Then removing four finished worktrees emptied `node_modules` in the main
// checkout, because `git worktree remove` deletes recursively and followed a
// junction that pointed at it.

const OPERATIONS = { MERGE_HEAD: 'merge', REBASE_HEAD: 'rebase', CHERRY_PICK_HEAD: 'cherry-pick', REVERT_HEAD: 'revert', BISECT_LOG: 'bisect' };

// The harness writes its own pointers into every worktree it creates, and a
// shared dependency directory is a link rather than work. Counting either as
// uncommitted work would make a worktree unsafe to retire from the moment it
// exists, and a check that always fires is a check nobody reads.
const HARNESS_FOOTPRINT = new Set(['AGENTS.md', 'CLAUDE.md']);
export const SHARED_DIRECTORIES = ['node_modules', '.venv', 'vendor'];

export function uncommitted(porcelain) {
  return porcelain.split(/\r?\n/).filter(Boolean)
    .map(line => line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop().trim())
    .filter(file => !HARNESS_FOOTPRINT.has(file) && !SHARED_DIRECTORIES.some(dir => file === dir || file.startsWith(`${dir}/`)));
}

export async function listWorktrees(repo) {
  const output = await git(repo, ['worktree', 'list', '--porcelain']);
  const entries = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { current = { path: line.slice(9) }; entries.push(current); }
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === 'detached') current.branch = null;
    else if (line.startsWith('HEAD ')) current.head = line.slice(5);
  }
  return entries;
}

/** A directory that is really a link somewhere else — the trap in `worktree remove`. */
export async function linkTarget(target) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) return await fs.readlink(target);
    // Windows junctions are not symlinks to `lstat`; the reparse bit is.
    if (process.platform === 'win32' && (stat.mode & 0o120000) !== 0o120000) {
      const probe = await runCommand('cmd', ['/c', 'dir', '/al', path.dirname(target)]).catch(() => null);
      if (probe && new RegExp(`<JUNCTION>\\s+${path.basename(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\[(.+?)\\]`).test(probe.stdout)) {
        return probe.stdout.match(new RegExp(`<JUNCTION>\\s+${path.basename(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\[(.+?)\\]`))[1];
      }
    }
    return null;
  } catch { return null; }
}

export async function inspect(repo, entry, { mainBranch = 'main' } = {}) {
  const report = { path: entry.path, branch: entry.branch ?? null, head: entry.head ?? null };
  try {
    report.dirty = uncommitted(await git(entry.path, ['status', '--porcelain'])).length;
    const gitDir = (await git(entry.path, ['rev-parse', '--absolute-git-dir'])).trim();
    report.operation = null;
    for (const [marker, name] of Object.entries(OPERATIONS)) if (await exists(path.join(gitDir, marker))) report.operation = name;
    if (entry.branch) {
      const base = await git(repo, ['rev-parse', '--verify', `${mainBranch}^{commit}`]).then(value => value.trim(), () => null);
      if (base) {
        const [behind, ahead] = (await git(entry.path, ['rev-list', '--left-right', '--count', `${base}...HEAD`])).trim().split(/\s+/).map(Number);
        Object.assign(report, { behind, ahead });
        report.merged = (await git(repo, ['branch', '--merged', mainBranch, '--list', entry.branch])).trim().length > 0;
      }
    }
    report.lastCommit = (await git(entry.path, ['log', '-1', '--format=%cI'])).trim() || null;
    report.sharedInstall = await linkTarget(path.join(entry.path, 'node_modules'));
  } catch (error) { report.error = error.message; }
  return report;
}

export async function inspectAll(repo, options = {}) {
  const entries = await listWorktrees(repo);
  const main = path.resolve(entries[0]?.path ?? repo);
  return Promise.all(entries.filter(entry => path.resolve(entry.path) !== main).map(entry => inspect(repo, entry, options)));
}

/** Everything that makes retiring this worktree unsafe right now. */
export function blockers(report) {
  const found = [];
  if (report.error) found.push(`cannot be inspected: ${report.error}`);
  if (report.dirty) found.push(`${report.dirty} uncommitted file(s)`);
  if (report.operation) found.push(`an unfinished ${report.operation}`);
  if (report.merged === false && report.ahead) found.push(`${report.ahead} commit(s) not in the base branch`);
  return found;
}

/**
 * Retire a worktree. Links are removed as links first; only then does git touch
 * the directory. `force` still refuses nothing silently: it records the reason
 * it was used.
 */
export async function retire(repo, target, { force = false, reason = null, mainBranch = 'main', removeBranch = true } = {}) {
  const resolved = path.resolve(target);
  const entry = (await listWorktrees(repo)).find(item => path.resolve(item.path) === resolved);
  assert(entry, `${target} is not a worktree of this repository`);
  assert(path.resolve(entry.path) !== path.resolve((await listWorktrees(repo))[0].path), 'The main checkout is not a worktree that can be retired');
  const report = await inspect(repo, entry, { mainBranch });
  const found = blockers(report);
  if (found.length) {
    assert(force, `Refusing to retire ${entry.path}: ${found.join('; ')}. Finish the work, or retire it with an explicit reason.`);
    assert(typeof reason === 'string' && reason.trim().length >= 8, 'Retiring a worktree that is not finished needs a recorded reason');
  }
  // Clean up after ourselves before asking git to remove the directory. The
  // generated pointers are untracked files that this harness wrote, and git
  // rightly refuses to delete a worktree containing them. Removing them here
  // keeps git's own refusal meaningful for everything else.
  const porcelain = await git(entry.path, ['status', '--porcelain']);
  for (const line of porcelain.split(/\r?\n/).filter(Boolean)) {
    const file = line.slice(3).replace(/^"|"$/g, '').trim();
    if (line.startsWith('??') && HARNESS_FOOTPRINT.has(file)) await fs.rm(path.join(entry.path, file), { force: true });
  }
  const unlinked = [];
  for (const name of SHARED_DIRECTORIES) {
    const candidate = path.join(entry.path, name);
    if (await linkTarget(candidate)) {
      // Remove the link itself. `rmdir` without recursion deletes a junction or
      // a directory symlink and leaves whatever it pointed at untouched.
      if (process.platform === 'win32') await runCommand('cmd', ['/c', 'rmdir', candidate]);
      else await fs.unlink(candidate);
      unlinked.push(name);
    }
  }
  await git(repo, ['worktree', 'remove', ...(found.length ? ['--force'] : []), entry.path]);
  let branch = null;
  if (removeBranch && entry.branch && report.merged) {
    await git(repo, ['branch', '-d', entry.branch]);
    branch = entry.branch;
  }
  return { path: entry.path, unlinked, branchDeleted: branch, forced: found.length > 0, blockers: found, reason: reason?.trim() ?? null };
}
