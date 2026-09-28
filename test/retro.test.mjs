import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { failureCause, inputTokens, retro } from '../src/retro.mjs';
import { atomicJSON } from '../src/io.mjs';
import { jobFile } from '../src/jobs.mjs';

async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'claudex-retro-test-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const state=path.join(root,'.local','claudex');
  await fs.mkdir(path.join(state,'jobs'),{recursive:true});
  return {root,state,config:{}};
}
const packet=role=>({taskId:'t',role,criteria:[{id:'a',text:'A'}]});

test('failure causes name what to do next, whichever field carried the error',()=>{
  assert.equal(failureCause({status:'FAILED',runtime:{provider:'claude'},error:'Worker exited unsuccessfully (1)',providerError:'You\'ve hit your weekly limit · resets Sep 19'}),'provider: QUOTA');
  assert.equal(failureCause({status:'TIMED_OUT',runtime:{provider:'codex'},providerError:'Reconnecting... waiting for network'}),'provider: NETWORK');
  assert.equal(failureCause({status:'TIMED_OUT',runtime:{provider:'codex'},termination:{confirmed:false}}),'timeout: termination unconfirmed');
  assert.equal(failureCause({status:'FAILED',error:'Another writer owns this worktree'}),'refused before start: Another writer owns this worktree');
  assert.equal(failureCause({status:'CANCELLED',error:'orphaned: worker 1 ended'}),'cancelled: orphaned worker');
});

test('input tokens are counted once per provider convention',()=>{
  assert.equal(inputTokens({provider:'codex',input_tokens:245591,cached_input_tokens:184448}),245591);
  assert.equal(inputTokens({provider:'claude',input_tokens:10,cache_creation_input_tokens:20965,cache_read_input_tokens:69832}),90807);
  assert.equal(inputTokens(null),0);
});

test('the retrospective counts statuses, causes, models and verdicts from the journal alone',async t=>{
  const ws=await fixture(t);
  const dir=path.join(ws.state,'artifacts','ok');
  await fs.mkdir(dir,{recursive:true});
  await atomicJSON(path.join(dir,'result.json'),{criteria:[{id:'a',status:'PASS'},{id:'b',status:'UNKNOWN'},{id:'c',status:'UNKNOWN'},{id:'d',status:'FAIL'}]});
  await atomicJSON(jobFile(ws,'ok'),{id:'ok',packet:packet('auditor'),status:'COMPLETED',created:'2026-09-20T10:00:00Z',updated:'2026-09-20T10:12:00Z',
    runtime:{provider:'codex',model:'gpt-5.6-sol'},usage:{provider:'codex',input_tokens:1000,cached_input_tokens:900,output_tokens:50},artifactDirectory:dir,evidenceFreshness:'STALE',resultGaps:{missing:['c'],unexpected:[]}});
  await atomicJSON(jobFile(ws,'quota'),{id:'quota',packet:packet('implementer'),status:'FAILED',created:'2026-09-21T10:00:00Z',updated:'2026-09-21T10:01:00Z',
    runtime:{provider:'claude',model:'sonnet'},providerError:'You\'ve hit your session limit',usage:{provider:'claude',input_tokens:5,cache_read_input_tokens:95,output_tokens:1,reportedCostUsd:0.5}});
  await atomicJSON(jobFile(ws,'old'),{id:'old',packet:packet('auditor'),status:'FAILED',created:'2026-09-01T10:00:00Z',error:'x'});
  const report=await retro(ws,{since:'2026-09-10'});
  assert.equal(report.window.jobs,2);
  assert.deepEqual(report.status,{COMPLETED:1,FAILED:1});
  assert.deepEqual(report.causes,{'provider: QUOTA':1});
  assert.deepEqual(report.byModel['codex/gpt-5.6-sol'],{jobs:1,completed:1,failed:0,reportedCostUsd:0,inputTokens:1000,outputTokens:50});
  assert.equal(report.byModel['claude/sonnet'].reportedCostUsd,0.5);
  assert.equal(report.byModel['claude/sonnet'].inputTokens,100);
  assert.deepEqual([report.criteria.answered,report.criteria.unknown,report.criteria.unknownShare,report.criteria.gapJobs],[4,2,0.5,1]);
  assert.equal(report.slowest[0].id,'ok');
  assert.ok(report.attention.some(line=>/provider limit/.test(line)));
  assert.ok(report.attention.some(line=>/50% of criterion verdicts were UNKNOWN/.test(line)));
  assert.ok(report.attention.some(line=>/finished STALE/.test(line)));
});
