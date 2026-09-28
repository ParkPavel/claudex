import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DIFF_LIMIT, reviewContext, toolSteps } from '../src/review.mjs';
import { validatePacket } from '../src/adapters.mjs';
import { atomicJSON } from '../src/io.mjs';
import { jobFile } from '../src/jobs.mjs';

const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true}).trim();
async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'claudex-review-test-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'project'),state=path.join(root,'.local','claudex');
  await fs.mkdir(path.join(repo,'src'),{recursive:true});
  await fs.mkdir(path.join(state,'jobs'),{recursive:true});
  git(repo,'init','-b','main');git(repo,'config','core.autocrlf','false');
  await fs.writeFile(path.join(repo,'src','sum.mjs'),'export const sum=(a,b)=>a+b;\n');
  await fs.writeFile(path.join(repo,'README.md'),'readme\n');
  git(repo,'add','.');git(repo,'-c','user.name=t','-c','user.email=t@invalid','commit','-m','base');
  return {ws:{root,state,project:repo},repo,base:git(repo,'rev-parse','HEAD')};
}
const reviewer={taskId:'r',role:'auditor',mode:'diff',authority:'read-only',goal:'Review',paths:['src'],criteria:[{id:'sum',text:'sum adds'}]};

test('a diff review carries its diff, new files included, and a step budget',async t=>{
  const {ws,repo,base}=await fixture(t);
  await fs.writeFile(path.join(repo,'src','sum.mjs'),'export const sum=(a,b)=>a-b;\n');
  await fs.writeFile(path.join(repo,'src','new.mjs'),'export const two=2;\n');
  await fs.writeFile(path.join(repo,'README.md'),'changed outside the scope\n');
  const {text,meta}=await reviewContext(ws,repo,reviewer,{base},{jobFile});
  assert.match(text,/-export const sum=\(a,b\)=>a\+b;/);
  assert.match(text,/\+export const sum=\(a,b\)=>a-b;/);
  assert.match(text,/new untracked file src\/new\.mjs\nexport const two=2;/);
  assert.doesNotMatch(text,/changed outside the scope/,'only the packet paths');
  assert.match(text,/within 40 tool calls/);
  assert.deepEqual([meta.untracked,meta.truncated,meta.budget],[1,false,40]);
});

test('a diff too long for the prompt is cut, with the file list kept',async t=>{
  const {ws,repo,base}=await fixture(t);
  await fs.writeFile(path.join(repo,'src','sum.mjs'),`${'x'.repeat(DIFF_LIMIT+5000)}\n`);
  const {text,meta}=await reviewContext(ws,repo,reviewer,{base},{jobFile});
  assert.equal(meta.truncated,true);
  assert.match(text,/src\/sum\.mjs \| /);
  assert.match(text,/diff cut at 60000 characters/);
});

test('a re-check carries the previous findings and only what changed since',async t=>{
  const {ws,repo,base}=await fixture(t);
  const dir=path.join(ws.state,'artifacts','first');
  await fs.mkdir(dir,{recursive:true});
  await atomicJSON(path.join(dir,'result.json'),{taskId:'r',criteria:[{id:'sum',status:'FAIL',evidence:['src/sum.mjs:1']}],findings:['src/sum.mjs:1 subtracts instead of adding'],unknowns:[]});
  await atomicJSON(jobFile(ws,'first'),{id:'first',status:'COMPLETED',packet:{...reviewer,worktree:null},before:{head:base},artifactDirectory:dir});
  await fs.writeFile(path.join(repo,'src','sum.mjs'),'export const sum=(a,b)=>a+b+0;\n');
  const {text,meta}=await reviewContext(ws,repo,{...reviewer,mode:'snapshot',recheckOf:'first'},{},{jobFile});
  assert.match(text,/re-check of review first/);
  assert.match(text,/1\. src\/sum\.mjs:1 subtracts instead of adding/);
  assert.match(text,/Criteria not passed last time: sum: FAIL/);
  assert.match(text,/\+export const sum=\(a,b\)=>a\+b\+0;/);
  assert.match(text,/within 20 tool calls/);
  assert.deepEqual([meta.recheckOf,meta.findings,meta.budget],['first',1,20]);
});

test('a re-check refuses a job that did not complete or reviewed another checkout',async t=>{
  const {ws,repo,base}=await fixture(t);
  await atomicJSON(jobFile(ws,'failed'),{id:'failed',status:'FAILED',packet:reviewer,before:{head:base}});
  await atomicJSON(jobFile(ws,'elsewhere'),{id:'elsewhere',status:'COMPLETED',packet:{...reviewer,worktree:'.local/claudex/worktrees/x'},before:{head:base}});
  await assert.rejects(reviewContext(ws,repo,{...reviewer,recheckOf:'failed'},{base},{jobFile}),/completed job/);
  await assert.rejects(reviewContext(ws,repo,{...reviewer,recheckOf:'elsewhere'},{base},{jobFile}),/same checkout/);
  await assert.rejects(reviewContext(ws,repo,{...reviewer,recheckOf:'missing'},{base},{jobFile}),/names no job/);
});

test('an explicit budget wins, and a snapshot review without one gets none',async t=>{
  const {ws,repo,base}=await fixture(t);
  assert.equal((await reviewContext(ws,repo,{...reviewer,budget:{toolCalls:12}},{base},{jobFile})).meta.budget,12);
  const plain=await reviewContext(ws,repo,{...reviewer,mode:'snapshot'},{},{jobFile});
  assert.deepEqual([plain.text,plain.meta],['',{}]);
});

test('packets: a re-check is read-only, and a budget is a bounded step count',async()=>{
  await assert.rejects(validatePacket({...reviewer,role:'implementer',authority:'workspace-write',worktree:'w',base:'HEAD',recheckOf:'first'}),/re-check is a read-only review/);
  await assert.rejects(validatePacket({...reviewer,base:'HEAD',recheckOf:'../x'}),/recheckOf must be a job ID/);
  await assert.rejects(validatePacket({...reviewer,base:'HEAD',budget:{toolCalls:0}}),/budget is/);
  await assert.rejects(validatePacket({...reviewer,base:'HEAD',budget:{toolCalls:5,tokens:9}}),/budget is/);
  await validatePacket({...reviewer,base:'HEAD',recheckOf:'first',budget:{toolCalls:25}});
});

test('tool steps are counted from both providers\' event streams',()=>{
  assert.equal(toolSteps({type:'item.completed',item:{type:'command_execution'}},'codex'),1);
  assert.equal(toolSteps({type:'item.started',item:{type:'command_execution'}},'codex'),0);
  assert.equal(toolSteps({type:'item.completed',item:{type:'agent_message'}},'codex'),0);
  assert.equal(toolSteps({type:'assistant',message:{content:[{type:'thinking'},{type:'tool_use'},{type:'tool_use'}]}},'claude'),2);
  assert.equal(toolSteps({type:'user'},'claude'),0);
});
