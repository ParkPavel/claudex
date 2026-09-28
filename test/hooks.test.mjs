import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { handoff, hookSettings, mergeHookSettings, preRun, reportReady, sessionStart } from '../src/hooks.mjs';
import { atomicJSON } from '../src/io.mjs';
import { jobFile } from '../src/jobs.mjs';

const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true});
async function fixture(t,access='approval') {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'claudex-hooks-test-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,'project'),state=path.join(root,'.local','claudex');
  await fs.mkdir(project,{recursive:true});
  await fs.mkdir(path.join(state,'jobs'),{recursive:true});
  git(project,'init','-b','main');
  await fs.writeFile(path.join(project,'app.txt'),'baseline\n');
  git(project,'add','.');
  git(project,'-c','user.name=Hook test','-c','user.email=test@invalid','commit','-m','baseline');
  return {root,project,state,config:{schemaVersion:2,project:'project',profile:'generic',access,maxWorkers:1,models:{codex:'m'},assignments:{},executables:{},obsidian:{}}};
}
const writer={taskId:'change',role:'implementer',mode:'snapshot',authority:'workspace-write',goal:'Change the app',paths:['app.txt'],criteria:[{id:'done',text:'Changed'}]};

test('a writing packet without worktree or approval is refused with the commands that fix it',async t=>{
  const ws=await fixture(t);
  await atomicJSON(path.join(ws.root,'writer.json'),writer);
  const out=await preRun(ws,{cwd:ws.root,tool_input:{command:'node claudex/bin/claudex.mjs run writer.json --wait'}});
  assert.equal(out.hookSpecificOutput.permissionDecision,'deny');
  const reason=out.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason,/A writer requires an assigned worktree/);
  assert.match(reason,/claudex worktree change --base HEAD --paths app.txt/);
  assert.match(reason,/claudex approve change/);
});

test('reading packets, other commands and a ready writer pass the gate untouched',async t=>{
  const ws=await fixture(t,'scoped');
  await atomicJSON(path.join(ws.root,'reader.json'),{...writer,role:'auditor',authority:'read-only'});
  assert.equal(await preRun(ws,{cwd:ws.root,tool_input:{command:'node claudex/bin/claudex.mjs run reader.json'}}),null);
  assert.equal(await preRun(ws,{cwd:ws.root,tool_input:{command:'git status'}}),null);
  await fs.mkdir(path.join(ws.root,'tree'));
  await atomicJSON(path.join(ws.root,'ready.json'),{...writer,worktree:'tree'});
  assert.equal(await preRun(ws,{cwd:ws.root,tool_input:{command:'node claudex/bin/claudex.mjs run ready.json'}}),null);
});

test('installing hooks keeps foreign entries and replaces earlier Claudex ones, including the old local scripts',()=>{
  const ws={root:'C:/work'};
  const current={permissions:{allow:['Bash(ls)']},hooks:{
    Stop:[{hooks:[{type:'command',command:'node C:/work/.local/claudex/hooks/handoff.mjs'}]},{hooks:[{type:'command',command:'notify-me'}]}],
    PreToolUse:[{matcher:'Bash',hooks:[{type:'command',command:'payload=$(cat); case "$payload" in *claudex.mjs*run*) node C:/work/.local/claudex/hooks/pre-run-gate.mjs ;; esac'}]}],
  }};
  const merged=mergeHookSettings(current,hookSettings(ws));
  assert.deepEqual(merged.permissions,current.permissions);
  assert.equal(merged.hooks.Stop.length,2);
  assert.equal(merged.hooks.Stop[0].hooks[0].command,'notify-me');
  assert.equal(merged.hooks.PreToolUse.length,1);
  assert.equal(merged.hooks.PreToolUse[0].matcher,'Bash|PowerShell');
  assert.deepEqual(merged.hooks.PreToolUse[0].hooks[0].args.slice(1),['hook','pre-run','--workspace','C:/work']);
  assert.deepEqual(mergeHookSettings(merged,hookSettings(ws)),merged);
});

test('a hook sharing an entry with a Claudex hook survives the install',()=>{
  const current={hooks:{Stop:[{hooks:[{type:'command',command:'node C:/w/.local/claudex/hooks/handoff.mjs'},{type:'command',command:'audit-log'}]}]}};
  const merged=mergeHookSettings(current,hookSettings({root:'C:/w'}));
  assert.deepEqual(merged.hooks.Stop[0].hooks,[{type:'command',command:'audit-log'}]);
  assert.equal(merged.hooks.Stop.length,2);
});

test('hooks run without a shell, so a path is never a command',()=>{
  const root='C:/work/$(calc)/`id`';
  for(const entries of Object.values(hookSettings({root})))for(const entry of entries)for(const hook of entry.hooks) {
    assert.equal(hook.command,process.execPath);
    assert.ok(hook.args.includes(root));
  }
});

test('at Stop the person gets a notice and nothing continues the conversation',async t=>{
  const ws=await fixture(t);
  const now=Date.parse('2026-09-28T12:00:00Z');
  await atomicJSON(jobFile(ws,'j1'),{id:'j1',taskId:'t1',status:'FAILED',updated:'2026-09-28T11:00:00Z',error:'x'});
  const atStop=await reportReady(ws,{now,event:'Stop'});
  assert.match(atStop.systemMessage,/1 job report\(s\) ready/);
  assert.equal(atStop.hookSpecificOutput,undefined,'Stop additionalContext would continue the conversation');
  assert.equal(atStop.decision,undefined);
  const delivered=await reportReady(ws,{now});
  assert.equal(delivered.hookSpecificOutput.hookEventName,'UserPromptSubmit');
  assert.match(delivered.hookSpecificOutput.additionalContext,/t1 -> FAILED/);
  assert.equal(await reportReady(ws,{now,event:'Stop'}),null);
});

test('a report is marked seen only when its whole block was delivered',async t=>{
  const ws=await fixture(t);
  const now=Date.parse('2026-09-28T12:00:00Z');
  // Four 200-character findings make each block about 900 characters.
  for(let i=1;i<=3;i++) {
    const dir=path.join(ws.state,'artifacts','L'+i);
    await fs.mkdir(dir,{recursive:true});
    await atomicJSON(path.join(dir,'result.json'),{criteria:[{id:'a',status:'FAIL'}],findings:Array.from({length:4},()=>'f'.repeat(220)),unknowns:[]});
    await atomicJSON(jobFile(ws,'L'+i),{id:'L'+i,taskId:'long'+i,status:'COMPLETED',updated:'2026-09-28T11:0'+i+':00Z',artifactDirectory:dir});
  }
  const first=(await reportReady(ws,{now})).hookSpecificOutput.additionalContext;
  assert.ok(first.length<=2000,String(first.length));
  const shown=(first.match(/long\d -> COMPLETED/g)??[]).length;
  assert.ok(shown>=1&&shown<3);
  const rest=(await reportReady(ws,{now})).hookSpecificOutput.additionalContext;
  assert.match(rest,new RegExp(`long${shown+1} -> COMPLETED`));
});

test('each session receives a report once, whichever session prompts first',async t=>{
  const ws=await fixture(t);
  const now=Date.parse('2026-09-28T12:00:00Z');
  await atomicJSON(jobFile(ws,'j1'),{id:'j1',taskId:'t1',status:'FAILED',updated:'2026-09-28T11:00:00Z',error:'x'});
  assert.match((await reportReady(ws,{now,session:'B'})).hookSpecificOutput.additionalContext,/t1 -> FAILED/);
  assert.match((await reportReady(ws,{now,event:'Stop',session:'A'})).systemMessage,/1 job report/);
  assert.match((await reportReady(ws,{now,session:'A'})).hookSpecificOutput.additionalContext,/t1 -> FAILED/);
  assert.equal(await reportReady(ws,{now,session:'A'}),null);
  assert.equal(await reportReady(ws,{now,session:'B'}),null);
});

test('an earlier workspace-wide ledger still counts, and a cut report keeps its path',async t=>{
  const ws=await fixture(t);
  const now=Date.parse('2026-09-28T12:00:00Z');
  await fs.mkdir(path.join(ws.state,'reports'),{recursive:true});
  await atomicJSON(path.join(ws.state,'reports','.reported-jobs.json'),['old']);
  await atomicJSON(jobFile(ws,'old'),{id:'old',taskId:'old',status:'FAILED',updated:'2026-09-28T11:00:00Z',error:'x'});
  const dir=path.join(ws.state,'artifacts','huge');
  await fs.mkdir(dir,{recursive:true});
  await atomicJSON(path.join(dir,'result.json'),{criteria:Array.from({length:300},(_,i)=>({id:`criterion-${i}`,status:'UNKNOWN'})),findings:[],unknowns:[]});
  await atomicJSON(jobFile(ws,'huge'),{id:'huge',taskId:'huge',status:'COMPLETED',updated:'2026-09-28T11:10:00Z',artifactDirectory:dir});
  const text=(await reportReady(ws,{now,session:'S'})).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(text,/old ->/);
  assert.match(text,/huge -> COMPLETED/);
  assert.match(text,/cut; read the full result/);
  assert.match(text,/full result: .*result\.json/);
  assert.ok(text.length<=2000,String(text.length));
});

test('a ledger keyed by session, from an earlier version, still counts',async t=>{
  const ws=await fixture(t);
  const now=Date.parse('2026-09-28T12:00:00Z');
  await fs.mkdir(path.join(ws.state,'reports'),{recursive:true});
  await atomicJSON(path.join(ws.state,'reports','.reported-jobs.json'),{A:['j1']});
  await atomicJSON(jobFile(ws,'j1'),{id:'j1',taskId:'t1',status:'FAILED',updated:'2026-09-28T11:00:00Z',error:'x'});
  assert.equal(await reportReady(ws,{now,session:'A'}),null);
  assert.match((await reportReady(ws,{now,session:'B'})).hookSpecificOutput.additionalContext,/t1 -> FAILED/,'another session still receives it');
});

test('sessions keep separate ledgers holding only fresh IDs, and abandoned ones are removed',async t=>{
  const ws=await fixture(t);
  const now=Date.now();
  const at=ms=>new Date(now-ms).toISOString();
  await atomicJSON(jobFile(ws,'new'),{id:'new',taskId:'new',status:'FAILED',updated:at(60000),error:'x'});
  await atomicJSON(jobFile(ws,'aged'),{id:'aged',taskId:'aged',status:'FAILED',updated:at(7*3600000),error:'x'});
  const dir=path.join(ws.state,'reports','seen');
  await fs.mkdir(dir,{recursive:true});
  await atomicJSON(path.join(dir,'gone.json'),['x']);
  const old=new Date(now-8*24*3600000);
  await fs.utimes(path.join(dir,'gone.json'),old,old);
  await reportReady(ws,{now,session:'A'});
  await reportReady(ws,{now,session:'B'});
  const files=(await fs.readdir(dir)).sort();
  assert.deepEqual(files,['A.json','B.json']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'A.json'),'utf8')),['new']);
  const odd=await reportReady(ws,{now,session:'../../escape'});
  assert.equal(odd.hookSpecificOutput.hookEventName,'UserPromptSubmit');
  assert.ok((await fs.readdir(dir)).every(name=>/^[\w-]+\.json$/.test(name)));
});

test('reports that do not fit wait for the next prompt instead of being lost',async t=>{
  const ws=await fixture(t);
  const now=Date.parse('2026-09-28T12:00:00Z');
  for(let i=1;i<=5;i++)await atomicJSON(jobFile(ws,'j'+i),{id:'j'+i,taskId:'t'+i,status:'FAILED',updated:'2026-09-28T11:0'+i+':00Z',error:'x'});
  const first=(await reportReady(ws,{now})).hookSpecificOutput.additionalContext;
  assert.match(first,/3 of 5; the rest follow/);
  assert.match(first,/t1 -> FAILED[\s\S]*t3 -> FAILED/);
  const second=(await reportReady(ws,{now})).hookSpecificOutput.additionalContext;
  assert.match(second,/t4 -> FAILED[\s\S]*t5 -> FAILED/);
  assert.equal(await reportReady(ws,{now}),null);
});

test('a finished job is reported once, and old backlog is not news',async t=>{
  const ws=await fixture(t);
  const now=Date.parse('2026-09-28T12:00:00Z');
  const dir=path.join(ws.state,'artifacts','review-1');
  await fs.mkdir(dir,{recursive:true});
  await atomicJSON(path.join(dir,'result.json'),{taskId:'review',criteria:[{id:'a',status:'FAIL',evidence:['x']}],findings:['src/a.ts:3 wrong total'],unknowns:[]});
  await atomicJSON(jobFile(ws,'review-1'),{id:'review-1',taskId:'review',status:'COMPLETED',updated:'2026-09-28T11:30:00Z',artifactDirectory:dir,resultGaps:{missing:['b'],unexpected:[]}});
  await atomicJSON(jobFile(ws,'old-1'),{id:'old-1',taskId:'old',status:'FAILED',updated:'2026-09-20T11:30:00Z',error:'x'});
  const first=await reportReady(ws,{now});
  assert.match(first.hookSpecificOutput.additionalContext,/review -> COMPLETED/);
  assert.match(first.hookSpecificOutput.additionalContext,/src\/a.ts:3 wrong total/);
  assert.match(first.hookSpecificOutput.additionalContext,/no answer for: b/);
  assert.doesNotMatch(first.hookSpecificOutput.additionalContext,/old ->/);
  assert.equal(await reportReady(ws,{now}),null);
});

test('session start names the project state; handoff writes only on change or at session end',async t=>{
  const ws=await fixture(t);
  const start=await sessionStart(ws);
  assert.match(start.hookSpecificOutput.additionalContext,/Project: main @ [0-9a-f]{12}, clean tree/);
  await handoff(ws,{hook_event_name:'Stop'});
  await handoff(ws,{hook_event_name:'Stop'});
  await handoff(ws,{hook_event_name:'SessionEnd'});
  const lines=(await fs.readFile(path.join(ws.state,'reports','handoff.jsonl'),'utf8')).trim().split('\n');
  assert.deepEqual(lines.map(line=>JSON.parse(line).event),['Stop','SessionEnd']);
  assert.match((await sessionStart(ws)).hookSpecificOutput.additionalContext,/Last handoff/);
});
