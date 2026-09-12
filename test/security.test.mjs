import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers.mjs';
import { inspectBlob, scan, prePush, preCommit } from '../src/security.mjs';
import { git } from '../src/io.mjs';

test('secret diagnostics never contain the credential value',()=>{
 const secret=['ghp','a'.repeat(36)].join('_');const findings=inspectBlob('config.json',Buffer.from(secret));assert.equal(findings[0].kind,'github-credential');assert(!JSON.stringify(findings).includes(secret));
});
test('private locations are rejected but source hashes are legitimate',()=>{
 assert.equal(inspectBlob('.local/workspace.json',Buffer.from('{}'))[0].kind,'private-path');
 assert.deepEqual(inspectBlob('sources.json',Buffer.from(JSON.stringify({sha256:'a'.repeat(64)}))),[]);
});
test('scan reads staged content, not a clean replacement in the working tree',async t=>{
 const ws=await fixture(t);const file=path.join(ws.project,'config.json');const secret=['ghp','b'.repeat(36)].join('_');await fs.writeFile(file,secret);await git(ws.project,['add','config.json']);await fs.writeFile(file,'{}');
 const result=await scan(ws.project);assert.equal(result.ok,false);assert(!JSON.stringify(result).includes(secret));
});
test('history scan catches a credential deleted in a later commit',async t=>{
 const ws=await fixture(t);const file=path.join(ws.project,'config.json');await fs.writeFile(file,['ghp','c'.repeat(36)].join('_'));await git(ws.project,['add','config.json']);await git(ws.project,['commit','-m','Fixture secret']);
 await fs.writeFile(file,'{}');await git(ws.project,['add','config.json']);await git(ws.project,['commit','-m','Remove fixture']);
 assert.equal((await scan(ws.project)).ok,true);assert.equal((await scan(ws.project,{history:true})).ok,false);
});
test('push blocks protected refs, deletion and non-fast-forward',async t=>{
 const ws=await fixture(t);const head=(await git(ws.project,['rev-parse','HEAD'])).trim();const zero='0'.repeat(40);
 await assert.rejects(prePush(ws.project,'origin','https://example.invalid/repo',`refs/heads/x ${head} refs/heads/main ${zero}`),/protected/);
 await assert.rejects(prePush(ws.project,'origin','https://example.invalid/repo',`refs/heads/x ${zero} refs/heads/x ${head}`),/deletion/);
 await assert.rejects(prePush(ws.project,'origin','https://example.invalid/repo',`refs/heads/x ${head} refs/heads/x ${'1'.repeat(40)}`),/Non-fast-forward/);
});
test('feature push is allowed only after complete reachable history scan',async t=>{
 const ws=await fixture(t);const head=(await git(ws.project,['rev-parse','HEAD'])).trim();const result=await prePush(ws.project,'origin','https://example.invalid/repo',`refs/heads/test ${head} refs/heads/test ${'0'.repeat(40)}`);assert.equal(result.ok,true);
});
test('direct commit to an established main is blocked',async t=>{
 const ws=await fixture(t);await git(ws.project,['branch','-m','main']);await assert.rejects(preCommit(ws.project),/protected/);
});

test('product baseline permits unchanged public blobs but rejects new secret history',async t=>{
 const ws=await fixture(t);const secret=['ghp','d'.repeat(36)].join('_');
 await fs.writeFile(path.join(ws.project,'legacy.txt'),secret);await git(ws.project,['add','.']);await git(ws.project,['commit','-m','Public baseline fixture']);
 const baseline=(await git(ws.project,['rev-parse','HEAD'])).trim();await git(ws.project,['config','claudex.publicationBaseline',baseline]);
 assert.equal((await preCommit(ws.project)).ok,true);
 await fs.writeFile(path.join(ws.project,'introduced.txt'),secret);await git(ws.project,['add','.']);
 await assert.rejects(preCommit(ws.project),/github-credential/);
 await git(ws.project,['commit','-m','Introduced fixture']);await git(ws.project,['rm','introduced.txt']);await git(ws.project,['commit','-m','Deleted fixture']);
 const tip=(await git(ws.project,['rev-parse','HEAD'])).trim();
 await assert.rejects(prePush(ws.project,'origin','https://example.invalid/repo',`refs/heads/test ${tip} refs/heads/test ${'0'.repeat(40)}`),/github-credential/);
});

test('baseline must be an ancestor and does not exempt relocated public blobs',async t=>{
 const ws=await fixture(t);const baseline=(await git(ws.project,['rev-parse','HEAD'])).trim();
 await fs.mkdir(path.join(ws.project,'.local'));await fs.writeFile(path.join(ws.project,'.local','private.txt'),'original\n');await git(ws.project,['add','-f','.local/private.txt']);
 assert.equal((await scan(ws.project,{baseline})).ok,false);
 await assert.rejects(scan(ws.project,{baseline:'a'.repeat(40)}),/ancestor/);
});

test('pushing the baseline itself cannot exempt symlinks or submodules',async t=>{
 for(const [mode,kind] of [['120000','publishable-symlink'],['160000','unreviewed-submodule']]) {
  const ws=await fixture(t);const object=(await git(ws.project,['rev-parse',mode==='120000'?'HEAD:source.txt':'HEAD'])).trim();
  await git(ws.project,['update-index','--add','--cacheinfo',`${mode},${object},external`]);
  await git(ws.project,['commit','-m','Nonregular baseline fixture']);
  const baseline=(await git(ws.project,['rev-parse','HEAD'])).trim();await git(ws.project,['config','claudex.publicationBaseline',baseline]);
  const result=await scan(ws.project,{history:true,revision:baseline,baseline});assert.equal(result.ok,false);assert(result.findings.some(f=>f.kind===kind));
  await assert.rejects(prePush(ws.project,'origin','https://example.invalid/repo',`refs/heads/test ${baseline} refs/heads/test ${'0'.repeat(40)}`),new RegExp(kind));
 }
});
