import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildPostmortem, runWorker, submit } from '../src/jobs.mjs';

const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true});
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'claudex-postmortem-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,'project'),state=path.join(root,'.local','claudex');
  await fs.mkdir(project,{recursive:true});
  await fs.mkdir(state,{recursive:true});
  await fs.writeFile(path.join(state,'generated-files.json'),'{}\n');
  git(project,'init','-b','main');
  git(project,'config','core.autocrlf','false');
  await fs.writeFile(path.join(project,'app.txt'),'baseline\n');
  git(project,'add','.');
  git(project,'-c','user.name=Postmortem test','-c','user.email=test@invalid','commit','-m','baseline');
  const ws={root,project,state,config:{schemaVersion:2,project:'project',profile:'generic',access:'scoped',maxWorkers:2,readyTimeoutMs:5000,runTimeoutMs:10000,
    models:{codex:'test-model'},assignments:{},executables:{codex:path.join(root,'missing-codex.exe')},obsidian:{}}};
  return {ws,project,root};
}
const packet={taskId:'probe',role:'auditor',mode:'snapshot',authority:'read-only',goal:'Review the app behavior',paths:['app.txt'],
  criteria:[{id:'behavior',text:'App behavior is reviewed'}]};

test('a failed job leaves a postmortem naming promise, stage, provider, leftovers and next checks',async t=>{
  const {ws,project}=await fixture(t);
  await fs.writeFile(path.join(project,'app.txt'),'uncommitted edit\n');
  const {jobId}=await submit(ws,packet,{start:false});
  await runWorker(ws,jobId);
  const job=JSON.parse(await fs.readFile(path.join(ws.state,'jobs',`${jobId}.json`),'utf8'));
  assert.equal(job.status,'FAILED');
  assert.ok(job.postmortem,'job points at its postmortem');
  const report=JSON.parse(await fs.readFile(path.resolve(ws.root,job.postmortem),'utf8'));
  assert.equal(report.jobId,jobId);
  assert.equal(report.status,'FAILED');
  assert.equal(report.promised.goal,packet.goal);
  assert.deepEqual(report.promised.criteria,['behavior']);
  assert.equal(report.failure.stage,'PREFLIGHT');
  assert.match(report.failure.error,/\S/);
  assert.equal(report.provider.provider,'codex');
  assert.equal(report.provider.model,'test-model');
  assert.deepEqual(report.leftovers.changed,['app.txt']);
  assert.ok(report.nextChecks.length>0);
  assert.ok(report.nextChecks.some(c=>/app\.txt|uncommitted|changes/i.test(c)),'leftover changes are called out');
});

test('completed jobs need no postmortem',()=>{
  assert.equal(buildPostmortem({status:'COMPLETED',packet},{changed:[]}),null);
});

test('a timeout before readiness is reported as such',()=>{
  const report=buildPostmortem({id:'x',taskId:'probe',status:'TIMED_OUT',stage:'STARTING',packet,runtime:{provider:'claude',model:'sonnet',effort:'low'}},{changed:[]});
  assert.equal(report.failure.stage,'STARTING');
  assert.ok(report.nextChecks.some(c=>/readiness|ready/i.test(c)));
});

test('renamed files are listed once, by their new name',async t=>{
  const {ws,project}=await fixture(t);
  git(project,'mv','app.txt','renamed.txt');
  await fs.writeFile(path.join(project,'new.txt'),'untracked\n');
  const {jobId}=await submit(ws,packet,{start:false});
  await runWorker(ws,jobId);
  const job=JSON.parse(await fs.readFile(path.join(ws.state,'jobs',`${jobId}.json`),'utf8'));
  const report=JSON.parse(await fs.readFile(path.resolve(ws.root,job.postmortem),'utf8'));
  assert.deepEqual(report.leftovers.changed.sort(),['new.txt','renamed.txt']);
});

test('a work-tree rename is listed once, by its new name',async t=>{
  const {ws,project}=await fixture(t);
  await fs.rename(path.join(project,'app.txt'),path.join(project,'moved.txt'));
  git(project,'add','-N','moved.txt');
  const {jobId}=await submit(ws,packet,{start:false});
  await runWorker(ws,jobId);
  const job=JSON.parse(await fs.readFile(path.join(ws.state,'jobs',`${jobId}.json`),'utf8'));
  const report=JSON.parse(await fs.readFile(path.resolve(ws.root,job.postmortem),'utf8'));
  assert.deepEqual(report.leftovers.changed,['moved.txt']);
});

test('the leftover list is capped but keeps the true count',()=>{
  const changed=Array.from({length:500},(_,i)=>`f${i}.txt`);
  const report=buildPostmortem({id:'x',taskId:'probe',status:'FAILED',stage:'RUNNING',packet},{changed});
  assert.equal(report.leftovers.count,500);
  assert.equal(report.leftovers.changed.length,200);
  assert.ok(report.leftovers.truncated);
});

test('a timeout caused by a lost connection says so instead of blaming the packet size',()=>{
  const job={id:'x',taskId:'probe',status:'TIMED_OUT',stage:'RUNNING',packet,runtime:{provider:'codex',model:'gpt-5.6-luna',effort:'high'},
    providerError:'Reconnecting... 4/5 (stream disconnected before completion: host unknown (os error 11001))'};
  const report=buildPostmortem(job,{changed:[]});
  assert.equal(report.failure.providerFailure?.kind,'NETWORK');
  assert.ok(report.nextChecks.some(c=>/connect/i.test(c)));
  assert.ok(!report.nextChecks.some(c=>/narrow the packet/.test(c)),'a network failure is not a packet-size problem');
});

test('Codex\'s own wording for a lost network is recognised',()=>{
  for (const text of ['Reconnecting... waiting for network (Connection failed: error sending request)','stream disconnected before completion']) {
    const report=buildPostmortem({id:'x',taskId:'probe',status:'TIMED_OUT',stage:'RUNNING',packet,runtime:{provider:'codex',model:'m',effort:'high'},providerError:text},{changed:[]});
    assert.equal(report.failure.providerFailure?.kind,'NETWORK',text);
  }
});

test('a model error that mentions a connection is not a network failure',()=>{
  const report=buildPostmortem({id:'x',taskId:'probe',status:'FAILED',stage:'RUNNING',packet,runtime:{provider:'codex',model:'m',effort:'high'},
    providerError:'invalid_request_error: unknown model gpt-x; connection failed validation'},{changed:[]});
  assert.equal(report.failure.providerFailure?.kind,'MODEL');
});
