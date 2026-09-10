import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const exec = promisify(execFile);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sha = data => crypto.createHash('sha256').update(data).digest('hex');
export const readJSON = async file => JSON.parse(await fs.readFile(file, 'utf8'));
export const exists = async file => fs.access(file).then(() => true, () => false);
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function inside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export async function contained(parent, child) {
  const realParent = await fs.realpath(parent);
  let cursor = path.resolve(child);
  const tail = [];
  while (!(await exists(cursor))) { tail.unshift(path.basename(cursor)); const next = path.dirname(cursor); assert(next !== cursor, 'Cannot resolve path'); cursor = next; }
  const real = path.join(await fs.realpath(cursor), ...tail);
  assert(inside(realParent, real), 'Path escapes its declared root');
  return real;
}
export async function atomicJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, file);
}
export async function git(cwd, args, options = {}) {
  return (await exec('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options })).stdout;
}
export async function resolveWorkspace(start = process.cwd()) {
  let cursor = path.resolve(start);
  while (true) {
    const descriptor = path.join(cursor, '.claudex.json');
    if (await exists(descriptor)) {
      const pointer = await readJSON(descriptor);
      assert(pointer.schemaVersion === 1, 'Unsupported workspace descriptor');
      const state = await contained(cursor, path.resolve(cursor, pointer.state));
      const config = await readJSON(path.join(state, 'workspace.json'));
      const project = await contained(cursor, path.resolve(cursor, config.project));
      assert(path.resolve((await git(project, ['rev-parse', '--show-toplevel'])).trim()) === path.resolve(project), 'Managed project must be a Git root');
      return { root: cursor, state, project, config };
    }
    const next = path.dirname(cursor);
    assert(next !== cursor, 'No .claudex.json found. Run claudex init from your workspace.');
    cursor = next;
  }
}
export async function withLock(state, fn) {
  await fs.mkdir(state, { recursive: true });
  const file = path.join(state, 'coordinator.lock');
  let handle;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { handle = await fs.open(file, 'wx', 0o600); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; await new Promise(r => setTimeout(r, 50)); }
  }
  assert(handle, 'Coordinator lock busy. Inspect owner before recovering a stale lock.');
  await handle.writeFile(JSON.stringify({ pid: process.pid, created: new Date().toISOString() }));
  try { return await fn(); }
  finally { await handle.close(); await fs.unlink(file); }
}
export async function snapshot(repo) {
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  const files = [...new Set((await git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean))].sort();
  const hash = crypto.createHash('sha256');
  hash.update(head);
  for (const file of files) {
    hash.update(`\0${file}\0`);
    const full = path.join(repo, file);
    try {
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) hash.update(`link:${await fs.readlink(full)}`);
      else if (stat.isFile()) hash.update(await fs.readFile(full));
      else hash.update('non-file');
    } catch (e) { if (e.code === 'ENOENT') hash.update('deleted'); else throw e; }
  }
  return { head, digest: hash.digest('hex'), fileCount: files.length };
}
export async function runtimeDigest(ws) {
  const hash = crypto.createHash('sha256');
  async function walk(dir) {
    for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else { hash.update(path.relative(ROOT, full)); hash.update(await fs.readFile(full)); }
    }
  }
  for (const dir of ['bin', 'config', 'profiles', 'skills', 'src']) await walk(path.join(ROOT, dir));
  hash.update(JSON.stringify(ws.config));
  const local = path.join(ws.state, 'project-profile.md');
  if (await exists(local)) hash.update(await fs.readFile(local));
  return hash.digest('hex');
}
