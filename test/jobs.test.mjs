import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { providerErrorText, validateResult } from '../src/adapters.mjs';
import { buildPostmortem, cancel, classifyProviderFailure, jobFile, waitForJobs } from '../src/jobs.mjs';
import { atomicJSON, readJSON } from '../src/io.mjs';
import { claim, readClaims } from '../src/claims.mjs';

async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'claudex-jobs-test-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const state=path.join(root,'.local','claudex');
  await fs.mkdir(path.join(state,'jobs'),{recursive:true});
  return {root,state,project:path.join(root,'project'),config:{maxWorkers:1}};
}
const packet={taskId:'probe',role:'auditor',mode:'snapshot',authority:'read-only',goal:'Review',paths:['a.txt'],
  criteria:[{id:'one',text:'First'},{id:'two',text:'Second'},{id:'three',text:'Third'}]};
// A pid that certainly belonged to a process which has already exited.
const deadPid=()=>spawnSync(process.execPath,['-e','process.pid'],{windowsHide:true}).pid;

// Wording copied from failed jobs in a working journal, not paraphrased.
test('Claude\'s session and weekly limits are quota, like Codex\'s usage limit',()=>{
  for (const [message,provider] of [
    ['You\'ve hit your session limit · resets 3:10pm (UTC)','claude'],
    ['You\'ve hit your weekly limit · resets Sep 19, 3pm (UTC)','claude'],
    ['You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 8:04 AM.','codex'],
  ]) {
    const failure=classifyProviderFailure(message,provider);
    assert.equal(failure?.kind,'QUOTA',message);
    assert.match(failure.suggestion,new RegExp(`--delegate ${provider}:`));
  }
  assert.equal(classifyProviderFailure('API Error: Can\'t reach the API server — check your internet or DNS (ENOTFOUND)','claude').kind,'NETWORK');
});

test('a Claude error result is reported by its sentence, so usage counters cannot read as HTTP 401',()=>{
  const event={type:'result',subtype:'success',is_error:true,result:'You\'ve hit your session limit · resets 1:20am',
    usage:{input_tokens:401,cache_creation_input_tokens:14013,output_tokens:403}};
  assert.equal(providerErrorText(event),'You\'ve hit your session limit · resets 1:20am');
  assert.equal(classifyProviderFailure(providerErrorText(event),'claude').kind,'QUOTA');
  assert.equal(providerErrorText({type:'error',message:'stream disconnected before completion'}),'stream disconnected before completion');
});

test('an omitted criterion becomes UNKNOWN with its reason instead of discarding the answer',()=>{
  const {result,gaps}=validateResult({taskId:'probe',findings:['a.txt:3 defect'],unknowns:[],
    criteria:[{id:'one',status:'PASS',evidence:['a.txt:1']},{id:'extra',status:'FAIL',evidence:[]}]},packet);
  assert.deepEqual(result.criteria.map(c=>[c.id,c.status]),[['one','PASS'],['two','UNKNOWN'],['three','UNKNOWN']]);
  assert.match(result.criteria[1].evidence[0],/no result/);
  assert.deepEqual(gaps,{missing:['two','three'],unexpected:['extra']});
  assert.deepEqual(result.findings,['a.txt:3 defect']);
  assert.equal(validateResult({taskId:'probe',findings:[],unknowns:[],criteria:packet.criteria.map(c=>({id:c.id,status:'UNKNOWN',evidence:[]}))},packet).gaps,null);
});

test('a result with no criterion answered, or an unsupported PASS, still fails',()=>{
  assert.throws(()=>validateResult({taskId:'probe',findings:[],unknowns:[],criteria:[]},packet),/No criterion results/);
  assert.throws(()=>validateResult({taskId:'probe',findings:[],unknowns:[],criteria:[{id:'one',status:'PASS',evidence:[]}]},packet),/PASS requires evidence/);
  assert.throws(()=>validateResult({taskId:'other',findings:[],unknowns:[],criteria:[]},packet),/identity/);
});

test('cancel closes a job whose worker and child are gone',async t=>{
  const ws=await fixture(t);
  const id='probe-orphan';
  await atomicJSON(jobFile(ws,id),{id,taskId:'probe',packet,status:'RUNNING',workerPid:deadPid(),childPid:deadPid(),acceptance:'UNKNOWN'});
  const result=await cancel(ws,id);
  assert.equal(result.status,'CANCELLED');
  assert.equal(result.orphaned,true);
  const job=await readJSON(jobFile(ws,id));
  assert.equal(job.status,'CANCELLED');
  assert.match(job.error,/^orphaned: worker \d+ and child \d+/);
});

test('closing an orphan releases its claimed scope',async t=>{
  const ws=await fixture(t);
  const id='writer-orphan';
  await atomicJSON(jobFile(ws,id),{id,taskId:'w',packet:{...packet,authority:'workspace-write'},status:'RUNNING',workerPid:deadPid(),childPid:null,acceptance:'UNKNOWN'});
  await claim(ws,{id,owner:'job',ref:'w (implementer)',paths:['a.txt']});
  assert.equal((await cancel(ws,id)).status,'CANCELLED');
  assert.ok(!JSON.stringify(await readClaims(ws)).includes(id),'claim released');
});

test('a queued job no worker ever picked up is closed after the grace period, not before',async t=>{
  const ws=await fixture(t);
  await atomicJSON(jobFile(ws,'stale'),{id:'stale',taskId:'s',packet,status:'QUEUED',workerPid:null,created:new Date(Date.now()-120000).toISOString()});
  await atomicJSON(jobFile(ws,'fresh'),{id:'fresh',taskId:'f',packet,status:'QUEUED',workerPid:null,created:new Date().toISOString()});
  assert.match((await cancel(ws,'stale')).error,/no worker ever started/);
  assert.equal((await cancel(ws,'fresh')).status,'CANCELLATION_REQUESTED');
});

test('an unconfirmed stop keeps its scope until cancel confirms the process ended',async t=>{
  const ws=await fixture(t);
  const id='stopped';
  await atomicJSON(jobFile(ws,id),{id,taskId:'x',packet:{...packet,authority:'workspace-write'},status:'TIMED_OUT',termination:{requestedAt:'2026-09-28T00:00:00Z',confirmed:false,pid:process.pid}});
  await claim(ws,{id,owner:'job',ref:'x',paths:['a.txt']});
  await assert.rejects(cancel(ws,id),new RegExp(`Provider process ${process.pid} of stopped still runs`));
  const job=await readJSON(jobFile(ws,id));
  await atomicJSON(jobFile(ws,id),{...job,termination:{...job.termination,pid:deadPid()}});
  // The direct child being gone is not the tree being gone: a person records it.
  await assert.rejects(cancel(ws,id),/--confirm-ended --reason/);
  assert.ok(JSON.stringify(await readClaims(ws)).includes(id),'scope still held');
  assert.equal((await cancel(ws,id,{confirmEnded:'Task Manager shows no codex or node children'})).terminationConfirmed,true);
  const confirmed=(await readJSON(jobFile(ws,id))).termination;
  assert.deepEqual([confirmed.confirmed,confirmed.confirmedBy,confirmed.reason],[true,'person','Task Manager shows no codex or node children']);
  assert.ok(!JSON.stringify(await readClaims(ws)).includes(id));
});

test('cancel refuses to close a job while its provider process still runs',async t=>{
  const ws=await fixture(t);
  const id='probe-live-child';
  await atomicJSON(jobFile(ws,id),{id,taskId:'probe',packet,status:'RUNNING',workerPid:deadPid(),childPid:process.pid,acceptance:'UNKNOWN'});
  await assert.rejects(cancel(ws,id),new RegExp(`provider process ${process.pid} still runs`));
  assert.equal((await readJSON(jobFile(ws,id))).status,'RUNNING');
});

test('a live worker gets a cancellation request, not a rewritten record',async t=>{
  const ws=await fixture(t);
  const id='probe-live';
  await atomicJSON(jobFile(ws,id),{id,taskId:'probe',packet,status:'RUNNING',workerPid:process.pid,childPid:null,acceptance:'UNKNOWN'});
  assert.equal((await cancel(ws,id)).status,'CANCELLATION_REQUESTED');
  assert.equal((await readJSON(jobFile(ws,id))).status,'RUNNING');
});

test('wait returns verdicts of finished jobs and names the ones still running',async t=>{
  const ws=await fixture(t);
  const artifacts=path.join(ws.state,'artifacts','probe-done');
  await fs.mkdir(artifacts,{recursive:true});
  await atomicJSON(path.join(artifacts,'result.json'),{taskId:'probe',findings:['a.txt:2 wrong'],unknowns:[],criteria:[{id:'one',status:'FAIL',evidence:['a.txt:2']}]});
  await atomicJSON(jobFile(ws,'probe-done'),{id:'probe-done',taskId:'probe',packet,status:'COMPLETED',proposedAcceptance:'FAIL',artifactDirectory:artifacts,resultGaps:{missing:['two'],unexpected:[]}});
  await atomicJSON(jobFile(ws,'probe-running'),{id:'probe-running',taskId:'probe',packet,status:'RUNNING',workerPid:process.pid});
  const waited=await waitForJobs(ws,['probe-done','probe-running'],{timeoutMs:50,intervalMs:10});
  assert.equal(waited.timedOut,true);
  assert.deepEqual(waited.pending,['probe-running']);
  assert.deepEqual(waited.jobs[0].criteria,[{id:'one',status:'FAIL'}]);
  assert.deepEqual(waited.jobs[0].findings,['a.txt:2 wrong']);
  assert.deepEqual(waited.jobs[0].resultGaps.missing,['two']);
  const twice=await waitForJobs(ws,['probe-done','probe-done'],{timeoutMs:5000,intervalMs:10});
  assert.deepEqual([twice.jobs.length,twice.timedOut],[1,false]);
  const all=await waitForJobs(ws,[],{timeoutMs:20,intervalMs:10});
  assert.deepEqual(all.pending,['probe-running']);
});

test('an unconfirmed termination is named in the postmortem',()=>{
  const report=buildPostmortem({id:'probe-x',taskId:'probe',packet,status:'TIMED_OUT',stage:'RUNNING',runtime:{provider:'codex',model:'m',effort:'high'},
    termination:{requestedAt:'2026-09-23T18:05:00.000Z',confirmed:false,pid:4242}});
  assert.ok(report.nextChecks.some(line=>/process 4242 was not confirmed/.test(line)));
});
