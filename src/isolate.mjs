import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert, exists, git, sha } from './io.mjs';

// Directories a build reads but the repository ignores. They are linked, never copied.
const DEFAULT_LINKS = ['node_modules'];

/**
 * Run `fn(dir)` in a disposable copy of the checkout: every tracked and every
 * untracked-but-not-ignored file as it is on disk now, uncommitted edits
 * included, so a mutating check (a build that rewrites a tracked bundle) tests
 * this snapshot without changing it. It isolates writes relative to the working
 * folder only; it is not a sandbox. A command writing to an absolute path, a
 * parent folder or the linked node_modules still reaches them -- callers compare
 * the checkout snapshot before and after, which catches the first two.
 *
 * Shared dependency directories are linked in. Cleanup unlinks every link and
 * confirms the link is gone before anything is removed recursively. Node's fs.rm
 * unlinks a junction, but `git worktree remove` and other deleters follow it and
 * empty the shared directory; the order keeps this safe whatever removes the copy.
 */
export async function withIsolatedCopy(repo, fn, { links = DEFAULT_LINKS } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-isolated-'));
  const made = [];
  try {
    const files = (await git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
    for (const rel of new Set(files)) {
      const from = path.join(repo, rel);
      if (!(await exists(from))) continue; // tracked but deleted in the working tree
      const to = path.join(dir, rel);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }
    for (const name of links) {
      const target = path.join(repo, name);
      if (!(await exists(target))) continue;
      const link = path.join(dir, name);
      await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      made.push(link);
    }
    return await fn(dir);
  } finally {
    let safe = true;
    for (const link of made) {
      try {
        await fs.unlink(link);
      } catch {}
      if (await fs.lstat(link).then(() => true, () => false)) safe = false;
    }
    // A link that could not be removed would carry the recursive delete into
    // the shared directory. Leave the copy behind rather than risk that.
    if (safe) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const WORKSPACE = '@workspace/';
/** Resolve a reproduction target: repository-relative, or workspace-relative with @workspace/. */
export function reproductionTarget(ws, repo, value) {
  return value.startsWith(WORKSPACE) ? { base: ws.root, rel: value.slice(WORKSPACE.length) } : { base: repo, rel: value };
}

// eol:'ignore' drops every CR before hashing: a checkout with core.autocrlf
// rewrites text assets to CRLF, so byte equality would fail on content that
// matches. The result then carries normalized:true; it is not a byte match.
async function fileSha(file, eol) {
  if (!(await exists(file))) return null;
  const bytes = await fs.readFile(file);
  return sha(eol === 'ignore' ? Buffer.from(bytes.toString('latin1').replaceAll('\r', ''), 'latin1') : bytes);
}

/** Compare each fresh output in the isolated copy with the files it must reproduce. */
export async function compareReproduction(ws, repo, dir, reproduces) {
  const out = [];
  for (const { output, against, eol } of reproduces) {
    const built = await fileSha(path.join(dir, output), eol);
    for (const value of against) {
      const { base, rel } = reproductionTarget(ws, repo, value);
      const file = path.resolve(base, rel);
      assert(file === base || file.startsWith(base + path.sep), 'Reproduction target escapes its root');
      // A link inside the root can still point outside it; compare real paths too.
      if (await exists(file)) {
        const realBase = await fs.realpath(base), realFile = await fs.realpath(file);
        assert(realFile === realBase || realFile.startsWith(realBase + path.sep), 'Reproduction target escapes its root through a link');
      }
      const expected = await fileSha(file, eol);
      out.push({ output, against: value, outputSha256: built, againstSha256: expected,
        ...(eol === 'ignore' ? { normalized: true } : {}),
        result: built === null || expected === null ? 'MISSING' : built === expected ? 'MATCH' : 'DIFFER' });
    }
  }
  return out;
}
