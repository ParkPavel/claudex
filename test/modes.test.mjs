import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, packet } from './helpers.mjs';
import { delegate, interactive, markUnavailable, mode, panel, readDelegation, recordJob, resolve, restore, settle, status } from '../src/modes.mjs';
import { roleTable } from '../src/modes.mjs';
import { submit, runWorker, listJobs, jobFile } from '../src/jobs.mjs';
import { readJSON } from '../src/io.mjs';

const codexOut = { unavailable: 'codex', substitute: 'claude', reason: 'Codex quota exhausted for the day' };

test('a delegation records who answered for whom, and why',async t=>{
 const ws=await fixture(t);
 const record=await delegate(ws,codexOut);
 assert.equal(record.unavailable,'codex');assert.equal(record.substitute,'claude');assert.equal(record.recheck,'OWED');
 assert.deepEqual(record.roles.sort(),Object.entries(await roleTable()).filter(([,role])=>role.provider==='codex').map(([name])=>name).sort());
 const state=await readDelegation(ws);
 assert.equal(mode(state),'single-model');assert.equal(state.providers.codex.available,false);
 assert.match(state.providers.codex.reason,/quota/);
});

test('a delegation needs a reason a later reader can use',async t=>{
 const ws=await fixture(t);
 await assert.rejects(delegate(ws,{...codexOut,reason:'out'}),/Record why/);
 await assert.rejects(delegate(ws,{...codexOut,reason:''}),/Record why/);
});

test('substitution never invents a provider, a self-handover or a chain',async t=>{
 const ws=await fixture(t);
 await assert.rejects(delegate(ws,{...codexOut,substitute:'gemini'}),/Unknown provider/);
 await assert.rejects(delegate(ws,{...codexOut,substitute:'codex'}),/cannot substitute for itself/);
 await delegate(ws,codexOut);
 await assert.rejects(delegate(ws,codexOut),/already has an open delegation/);
 await assert.rejects(delegate(ws,{unavailable:'claude',substitute:'codex',reason:'Claude quota exhausted too',roles:['lead']}),/itself unavailable/);
});

test('a delegation cannot widen authority or move a role its owner does not have',async t=>{
 const ws=await fixture(t);
 await assert.rejects(delegate(ws,{unavailable:'claude',substitute:'codex',reason:'Claude quota exhausted today',roles:['implementer']}),/read-only roles only/);
 await assert.rejects(delegate(ws,{...codexOut,roles:['lead']}),/does not belong to codex/);
});

test('an unavailable provider with no substitute refuses the job instead of answering',async t=>{
 const ws=await fixture(t);
 await markUnavailable(ws,{provider:'codex',reason:'Codex quota exhausted for the day'});
 await assert.rejects(submit(ws,packet(),{start:false}),/marked unavailable/);
 const table=await roleTable();
 await assert.rejects(resolve(ws,'auditor',table.auditor),/Delegate its roles or restore it/);
});

test('a delegated job carries its provenance and its debt',async t=>{
 const ws=await fixture(t);
 const record=await delegate(ws,codexOut);
 const { jobId }=await submit(ws,packet(),{start:false});
 const job=await readJSON(jobFile(ws,jobId));
 assert.equal(job.delegation.id,record.id);assert.equal(job.delegation.from,'codex');assert.equal(job.delegation.to,'claude');
 assert.equal(job.independence,'SINGLE_MODEL');assert.equal(job.recheck,'OWED');
 assert.deepEqual((await readDelegation(ws)).open[0].jobs,[jobId]);
 const report=await status(ws,await listJobs(ws));
 assert.equal(report.debt.length,1);assert.equal(report.debt[0].jobs[0].jobId,jobId);assert.equal(report.debt[0].answeredBy,'claude');
});

test('a job without a delegation is marked as the cross-provider case',async t=>{
 const ws=await fixture(t);
 const { jobId }=await submit(ws,packet(),{start:false});
 const job=await readJSON(jobFile(ws,jobId));
 assert.equal(job.delegation,null);assert.equal(job.independence,'CROSS_PROVIDER');assert.equal(job.recheck,'NONE');
});

test('a queued job refuses to run under a delegation nobody agreed to',async t=>{
 const ws=await fixture(t);
 await delegate(ws,codexOut);
 const { jobId }=await submit(ws,packet(),{start:false});
 await restore(ws,{provider:'codex'});
 await runWorker(ws,jobId);
 const job=await readJSON(jobFile(ws,jobId));
 assert.equal(job.status,'FAILED');assert.match(job.error,/Delegation changed/);
});

test('restoring a provider returns its roles but does not pay the debt',async t=>{
 const ws=await fixture(t);
 const record=await delegate(ws,codexOut);
 const { jobId }=await submit(ws,packet(),{start:false});
 const closed=(await restore(ws,{provider:'codex',note:'quota reset'})).closed;
 assert.equal(closed.id,record.id);assert.equal(closed.recheck,'OWED');assert.equal(closed.note,'quota reset');
 const state=await readDelegation(ws);
 assert.equal(mode(state),'dual-model');assert.equal(state.providers.codex,undefined);
 assert.equal((await status(ws,await listJobs(ws))).debt[0].jobs[0].jobId,jobId);
});

test('an unused delegation owes nothing when it closes',async t=>{
 const ws=await fixture(t);
 await delegate(ws,codexOut);
 assert.equal((await restore(ws,{provider:'codex'})).closed.recheck,'NONE');
 assert.deepEqual((await status(ws,[])).debt,[]);
});

test('a debt is settled only with evidence, only after the provider is back',async t=>{
 const ws=await fixture(t);
 const record=await delegate(ws,codexOut);
 await recordJob(ws,record.id,'T1-job');
 await assert.rejects(settle(ws,{id:record.id,evidence:['artifact']}),/still open/);
 await restore(ws,{provider:'codex'});
 await assert.rejects(settle(ws,{id:record.id,evidence:[]}),/needs at least one evidence/);
 const settled=await settle(ws,{id:record.id,evidence:'jobs/T1-recheck.json, artifacts/T1-recheck'});
 assert.equal(settled.recheck,'SETTLED');assert.deepEqual(settled.evidence,['jobs/T1-recheck.json','artifacts/T1-recheck']);
 await assert.rejects(settle(ws,{id:record.id,evidence:['again']}),/owes no re-check/);
 assert.deepEqual((await status(ws,[])).debt,[]);
});

test('restoring a provider that was never marked is refused rather than silently accepted',async t=>{
 const ws=await fixture(t);
 await assert.rejects(restore(ws,{provider:'codex'}),/not marked unavailable/);
});

test('the window shows the current arrangement and the acts available',async t=>{
 const ws=await fixture(t);
 const record=await delegate(ws,codexOut);
 const text=panel(await status(ws,await listJobs(ws)));
 assert.match(text,/single-model/);assert.match(text,/codex\s+unavailable/);assert.match(text,/codex → claude/);
 assert.ok(text.includes(record.id));assert.match(text,/\[d\] delegate/);
});

test('the window drives the same acts as the flags, and reports a refusal without exiting',async t=>{
 const ws=await fixture(t);
 const written=[];
 const answers=['d','codex','codex','Codex quota exhausted for the day','d','codex','claude','Codex quota exhausted for the day','r','codex','quota reset','q'];
 const session=await interactive(ws,{write:text=>written.push(text),question:async()=>answers.shift()},listJobs);
 assert.deepEqual(session.acts.map(act=>act.act),['delegate','restore']);
 assert.ok(written.some(text=>/Refused: A provider cannot substitute for itself/.test(text)));
 assert.equal(mode(await readDelegation(ws)),'dual-model');
 assert.equal((await readDelegation(ws)).history[0].recheck,'NONE');
});
