import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, packet } from './helpers.mjs';
import { contained, snapshot, resolveWorkspace, atomicJSON } from '../src/io.mjs';
import { validatePacket, validateResult, prepareAdapter } from '../src/adapters.mjs';
import { syncWorkspace, checkEntrypoints, createWorktree } from '../src/workspace.mjs';
import { submit, runWorker, jobFile, cancel, inspectJobs } from '../src/jobs.mjs';
import { obsidianArgs, parseVaultIdentity } from '../src/obsidian.mjs';

test('workspace resolves consistently from desktop and project',async t=>{
 const ws=await fixture(t);assert.equal((await resolveWorkspace(ws.root)).project,ws.project);assert.equal((await resolveWorkspace(ws.project)).root,ws.root);
});
test('path traversal and junction escape are rejected',async t=>{
 const ws=await fixture(t);await assert.rejects(contained(ws.project,path.join(ws.root,'private.txt')),/escapes/);
 const link=path.join(ws.project,'outside');await fs.symlink(ws.state,link,process.platform==='win32'?'junction':'dir');
 await assert.rejects(contained(ws.project,path.join(link,'x')),/escapes/);
});
test('dirty and untracked content invalidate snapshots without a HEAD change',async t=>{
 const ws=await fixture(t);const before=await snapshot(ws.project);await fs.writeFile(path.join(ws.project,'source.txt'),'changed');
 const dirty=await snapshot(ws.project);assert.equal(before.head,dirty.head);assert.notEqual(before.digest,dirty.digest);
 await fs.writeFile(path.join(ws.project,'new.txt'),'one');const first=await snapshot(ws.project);await fs.writeFile(path.join(ws.project,'new.txt'),'two');assert.notEqual(first.digest,(await snapshot(ws.project)).digest);
});
test('sync is idempotent and refuses to overwrite edited native configuration',async t=>{
 const ws=await fixture(t);await syncWorkspace(ws);assert.deepEqual(await checkEntrypoints(ws),[]);
 await fs.appendFile(path.join(ws.root,'AGENTS.md'),'user edit');await assert.rejects(syncWorkspace(ws),/edited entrypoint/);
});
test('read-only roles cannot request writing and snapshot mode needs no diff',async()=>{
 await validatePacket(packet());await assert.rejects(validatePacket(packet({authority:'workspace-write'})),/escalated/);
 await assert.rejects(validatePacket(packet({mode:'diff'})),/base/);
});
test('writer requires isolated worktree; malformed criteria are rejected',async()=>{
 await assert.rejects(validatePacket(packet({role:'implementer',authority:'workspace-write'})),/worktree/);
 await assert.rejects(validatePacket(packet({criteria:[{id:'A',text:'one'},{id:'A',text:'two'}]})),/Duplicate/);
});
test('adapter uses requested effort and mandatory read-only without inherited user config',async t=>{
 const ws=await fixture(t);const p=packet();const role=await validatePacket(p);const adapter=await prepareAdapter(ws,p,role);
 assert(adapter.args.includes('read-only'));assert(adapter.args.includes('--ignore-user-config'));assert(adapter.args.includes('model_reasoning_effort="medium"'));
 assert(!adapter.args.includes('--dangerously-bypass-approvals-and-sandbox'));
});
test('Claude adapter preserves native OAuth while disabling customizations',async t=>{
 const ws=await fixture(t);ws.config.executables.claude=ws.config.executables.codex;
 const p=packet({role:'architect'});const adapter=await prepareAdapter(ws,p,await validatePacket(p));
 assert(adapter.args.includes('--safe-mode'));assert(adapter.args.includes('--restricted'));assert(!adapter.args.includes('--bare'));
 assert(adapter.args.includes('mcp__*'));assert(!adapter.args.includes('Bash'));
});
test('acceptance proposal needs matching criterion identities and evidence',()=>{
 const p=packet();const answer={taskId:'T1',criteria:[{id:'AC1',status:'PASS',evidence:[]}],findings:[],unknowns:[]};
 assert.throws(()=>validateResult(answer,p),/evidence/);answer.criteria[0].evidence=['source.txt'];validateResult(answer,p);
 answer.taskId='another';assert.throws(()=>validateResult(answer,p),/identity/);
});
test('worktree bootstrap contains minimal entrypoints and preserves original project',async t=>{
 const ws=await fixture(t);const tree=await createWorktree(ws,'writer');assert(await fs.readFile(path.join(tree.path,'AGENTS.md'),'utf8'));
 assert.equal(await fs.readFile(path.join(ws.project,'source.txt'),'utf8'),'original\n');
});
test('real worker process completes but model PASS does not become acceptance',async t=>{
 const ws=await fixture(t);const result=await submit(ws,packet(),{start:false});await runWorker(ws,result.jobId);
 const job=JSON.parse(await fs.readFile(jobFile(ws,result.jobId),'utf8'));assert.equal(job.status,'COMPLETED');assert.equal(job.proposedAcceptance,'PASS');assert.equal(job.acceptance,'UNKNOWN');assert.equal(job.evidenceFreshness,'CURRENT');
});
test('changed source makes read-only job evidence stale',async t=>{
 const ws=await fixture(t);const result=await submit(ws,packet({goal:'mutate'}),{start:false});await runWorker(ws,result.jobId);
 const job=JSON.parse(await fs.readFile(jobFile(ws,result.jobId),'utf8'));assert.equal(job.evidenceFreshness,'STALE');assert.equal(job.acceptance,'UNKNOWN');
});
test('status revalidates evidence after a completed job',async t=>{
 const ws=await fixture(t);const result=await submit(ws,packet(),{start:false});await runWorker(ws,result.jobId);
 assert.equal((await inspectJobs(ws,result.jobId)).evidenceFreshness,'CURRENT');
 await fs.writeFile(path.join(ws.project,'source.txt'),'later change');assert.equal((await inspectJobs(ws,result.jobId)).evidenceFreshness,'STALE');
});
test('a worker without readiness times out and its process ends',async t=>{
 const ws=await fixture(t);const result=await submit(ws,packet({goal:'wait'}),{start:false});await runWorker(ws,result.jobId);
 const job=JSON.parse(await fs.readFile(jobFile(ws,result.jobId),'utf8'));assert.equal(job.status,'TIMED_OUT');assert.throws(()=>process.kill(job.childPid,0));
 assert.equal(await fs.readFile(path.join(job.artifactDirectory,'packet.json'),'utf8'),JSON.stringify(job.packet,null,2));
});

test('failed provider keeps its artifact directory and diagnostic stream',async t=>{
 const ws=await fixture(t);await fs.appendFile(ws.config.executables.codex,'\nif(!process.argv.includes("--help")&&!process.argv.includes("--version")){console.error("fixture failure");process.exitCode=2;}\n');
 const result=await submit(ws,packet(),{start:false});await runWorker(ws,result.jobId);
 const job=JSON.parse(await fs.readFile(jobFile(ws,result.jobId),'utf8'));assert.equal(job.status,'FAILED');
 assert.match(await fs.readFile(path.join(job.artifactDirectory,'stderr.log'),'utf8'),/fixture failure/);
 assert.equal(job.acceptance,'UNKNOWN');
});
test('duplicate active task rejected and queued cancellation preserved',async t=>{
 const ws=await fixture(t);const result=await submit(ws,packet(),{start:false});await assert.rejects(submit(ws,packet(),{start:false}),/active job/);
 await cancel(ws,result.jobId);await runWorker(ws,result.jobId);const job=JSON.parse(await fs.readFile(jobFile(ws,result.jobId),'utf8'));assert.equal(job.status,'CANCELLED');
});
test('a duplicate worker cannot overwrite another worker journal',async t=>{
 const ws=await fixture(t);const result=await submit(ws,packet(),{start:false});const file=jobFile(ws,result.jobId);
 const job=JSON.parse(await fs.readFile(file,'utf8'));job.status='RUNNING';job.workerPid=process.pid;await atomicJSON(file,job);
 await runWorker(ws,result.jobId);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).status,'RUNNING');
});
async function waitFor(ws,id,predicate) {
 const deadline=Date.now()+10000;
 while(Date.now()<deadline) { const job=JSON.parse(await fs.readFile(jobFile(ws,id),'utf8'));if(predicate(job))return job;await new Promise(r=>setTimeout(r,25)); }
 throw new Error('Timed out waiting for fixture job state');
}
test('managed jobs share a concurrency cap across worker loops',async t=>{
 const ws=await fixture(t);ws.config.maxWorkers=1;ws.config.readyTimeoutMs=1500;
 const first=await submit(ws,packet({taskId:'one',goal:'wait'}),{start:false});
 const second=await submit(ws,packet({taskId:'two'}),{start:false});
 const running=runWorker(ws,first.jobId);await waitFor(ws,first.jobId,j=>j.childPid);
 const queued=runWorker(ws,second.jobId);await new Promise(r=>setTimeout(r,100));
 assert.equal(JSON.parse(await fs.readFile(jobFile(ws,second.jobId),'utf8')).status,'QUEUED');
 await Promise.all([running,queued]);assert.equal(JSON.parse(await fs.readFile(jobFile(ws,second.jobId),'utf8')).status,'COMPLETED');
});
test('running cancellation waits for provider termination',async t=>{
 const ws=await fixture(t);ws.config.readyTimeoutMs=4000;
 const result=await submit(ws,packet({goal:'wait'}),{start:false});const running=runWorker(ws,result.jobId);
 const started=await waitFor(ws,result.jobId,j=>j.childPid);await cancel(ws,result.jobId);await running;
 assert.equal(JSON.parse(await fs.readFile(jobFile(ws,result.jobId),'utf8')).status,'CANCELLED');assert.throws(()=>process.kill(started.childPid,0));
});
test('Obsidian arguments pin the vault first and keep strings as single arguments',()=>{
 const args=obsidianArgs('Test Vault','read',{path:'Folder/My Note.md'});assert.deepEqual(args,['vault=Test Vault','read','path=Folder/My Note.md']);
 assert.throws(()=>obsidianArgs('','read',{}),/identity/);assert.throws(()=>obsidianArgs('Test','read',{vault:'Other'}),/Unsupported/);
 assert.throws(()=>obsidianArgs('Test','delete',{path:'x'}),/Unsupported/);
});
test('Obsidian native eval prefix is handled without relaxing vault identity',()=>{
 assert.equal(parseVaultIdentity('=> /test/vault\n'),'/test/vault');
 assert.equal(parseVaultIdentity('"/test/vault"\n'),'/test/vault');
 assert.equal(parseVaultIdentity('Error: vault missing'),'Error: vault missing');
});
