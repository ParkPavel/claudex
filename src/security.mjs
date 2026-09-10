import fs from 'node:fs/promises';
import path from 'node:path';
import { git, assert, exists } from './io.mjs';

const forbiddenPath = /(^|\/)(\.local|\.tmp|\.ai_internal|node_modules|agent-memory|sessions|backups|vaults|artifacts)(\/|$)|(^|\/)\.env($|\.(?!example$))|settings\.local\.json$|auth\.json$|credentials|\.(pem|key|p12|pfx|bundle)$/i;
const rules = [
  ['private-key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['github-credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['provider-credential', /\bsk-(?:ant-[A-Za-z0-9_-]{25,}|[A-Za-z0-9_-]{32,})\b/],
  ['credential-literal', /(?:api[_-]?key|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*["'][A-Za-z0-9+/_=-]{24,}["']/i],
  ['private-machine-path', /(?:[A-Z]:[\\/]Users[\\/][^\s/\\"']+|\/(?:Users|home)\/[a-zA-Z0-9._-]+\/)/],
];
export function inspectBlob(file, bytes) {
  const findings = [];
  if (forbiddenPath.test(file)) findings.push({ file, kind: 'private-path' });
  if (bytes.includes(0)) return findings;
  bytes.toString('utf8').split(/\r?\n/).forEach((line, i) => {
    for (const [kind, pattern] of rules) if (pattern.test(line)) findings.push({ file, line: i + 1, kind });
  });
  return findings;
}
export async function scan(repo, { history = false, revision } = {}) {
  const findings = [];
  const seen = new Set();
  const revisions = history ? (await git(repo, ['rev-list', ...(revision ? [revision] : ['--all'])])).trim().split('\n').filter(Boolean) : [null];
  for (const rev of revisions) {
    const raw = rev ? await git(repo, ['ls-tree', '-rz', rev]) : await git(repo, ['ls-files', '--stage', '-z']);
    for (const record of raw.split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t');
      const file = record.slice(tab + 1);
      const meta = record.slice(0, tab).split(' ');
      const mode = meta[0];
      const oid = rev ? meta[2] : meta[1];
      if (mode === '160000') { findings.push({ file, kind: 'unreviewed-submodule' }); continue; }
      if (mode === '120000') { findings.push({ file, kind: 'publishable-symlink' }); continue; }
      const key = `${file}:${oid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const blob = await git(repo, ['cat-file', 'blob', oid], { encoding: 'buffer' });
      findings.push(...inspectBlob(file, blob).map(f => ({ ...f, ...(rev ? { commit: rev } : {}) })));
    }
  }
  return { ok: findings.length === 0, blobsChecked: seen.size, findings };
}
export async function preCommit(repo) {
  const branch = (await git(repo, ['branch', '--show-current'])).trim();
  let unborn = false;
  try { await git(repo, ['rev-parse', '--verify', 'HEAD']); } catch { unborn = true; }
  assert(unborn || !['main','master'].includes(branch), 'Direct commits to protected branches are blocked. Use a feature branch.');
  const result = await scan(repo);
  assert(result.ok, JSON.stringify(result.findings));
  return result;
}
export async function prePush(repo, remote, url, input) {
  const gitDir = (await git(repo, ['rev-parse', '--absolute-git-dir'])).trim();
  const permitPath = path.join(gitDir, 'claudex-initial-publication.json');
  const permit = await exists(permitPath) ? JSON.parse(await fs.readFile(permitPath, 'utf8')) : null;
  let usedPermit = false;
  const lines = input.trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const fields = line.split(' ');
    assert(fields.length === 4, 'Invalid Git pre-push input');
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    assert(/^[0-9a-f]{40,64}$/.test(localSha) && /^[0-9a-f]{40,64}$/.test(remoteSha), 'Invalid push object ID');
    assert(!/^0+$/.test(localSha), 'Remote ref deletion is blocked');
    if (/^refs\/heads\/(main|master)$/.test(remoteRef)) {
      const initial = /^0+$/.test(remoteSha) && permit?.sha === localSha && permit?.url === url && permit?.ref === remoteRef && Date.now() < permit?.expires;
      assert(initial, 'Direct push to protected branch blocked. Use a pull request.');
      usedPermit = true;
    }
    if (!/^0+$/.test(remoteSha)) {
      assert(!remoteRef.startsWith('refs/tags/'), 'Existing tags are immutable');
      try { await git(repo, ['merge-base', '--is-ancestor', remoteSha, localSha]); }
      catch { throw new Error('Non-fast-forward or unknown remote base blocked; fetch and inspect before retrying.'); }
    }
    const result = await scan(repo, { history: true, revision: localSha });
    assert(result.ok, JSON.stringify(result.findings));
    assert(localRef.startsWith('refs/') || localRef === 'HEAD', 'Invalid local ref');
  }
  if (usedPermit) await fs.unlink(permitPath);
  return { ok: true, remote, refsChecked: lines.length };
}
