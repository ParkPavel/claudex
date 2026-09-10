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
