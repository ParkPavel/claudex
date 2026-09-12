import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fixture, packet } from './helpers.mjs';
import { atomicJSON, readJSON, resolveWorkspace } from '../src/io.mjs';
import { CONFIG_VERSION, defaultConfig, migrateConfig, resolveAssignment, validateConfig } from '../src/config.mjs';
import { syncWorkspace, createWorktree } from '../src/workspace.mjs';
import { submit } from '../src/jobs.mjs';
import { approve, readApproval } from '../src/approvals.mjs';
import { chooseAssignments, projectProblem, runSetup, summary } from '../src/setup.mjs';

const roles = () => readJSON(new URL('../config/roles.json', import.meta.url));

const scripted = answers => {
  const written = [];
  const queue = [...answers];
  return { written, io: { write: value => written.push(value), question: async () => (queue.length ? queue.shift() : 'skip') } };
};

test('a version 1 configuration is read as the access it actually enforced',async()=>{
 const { config, migrated, from }=migrateConfig({schemaVersion:1,project:'p',profile:'generic',maxWorkers:3,models:{codex:null},executables:{},obsidian:{}});
 assert.equal(from,1);assert.equal(migrated,true);
 // Version 1 required a worktree on a feature branch and nothing more. Calling
 // that "approval" would claim a protection those installations never had.
 assert.equal(config.access,'scoped');
 assert.equal(config.schemaVersion,CONFIG_VERSION);
 assert.deepEqual(config.assignments,{});
});

test('a fresh installation asks before it writes',async()=>{
 assert.equal(defaultConfig({project:'p'}).access,'approval');
});

test('an unreadable version is refused rather than guessed',async()=>{
 assert.throws(()=>migrateConfig({schemaVersion:99}),/Unsupported workspace configuration version/);
 assert.throws(()=>migrateConfig(null),/Malformed/);
});

test('an assignment cannot move a writing role to a read-only provider',async()=>{
 const table=await roles();
 const config=defaultConfig({project:'p'});
 config.assignments={implementer:{provider:'codex'}};
 assert.throws(()=>validateConfig(config,table),/codex serves read-only roles only/);
 config.assignments={auditor:{provider:'claude',model:'opus'}};
 assert.equal(validateConfig(config,table).assignments.auditor.provider,'claude');
});

test('an assignment overrides the role default, and nothing else does',async()=>{
 const table=await roles();
 const config=defaultConfig({project:'p'});
 config.assignments={architect:{provider:'codex',model:'gpt-5.6-terra',effort:'max'}};
 const architect=resolveAssignment(config,'architect',table.architect);
 assert.equal(architect.provider,'codex');assert.equal(architect.model,'gpt-5.6-terra');assert.equal(architect.effort,'max');
 const untouched=resolveAssignment(config,'designer',table.designer);
 assert.equal(untouched.provider,table.designer.provider);assert.equal(untouched.model,table.designer.model);
});

test('moving a role to another provider drops a model that belonged to the old one',async()=>{
 const table=await roles();
 const config=defaultConfig({project:'p'});
 config.assignments={tester:{provider:'codex'}};
 // `sonnet` means nothing to codex; the provider default answers instead.
 assert.equal(resolveAssignment(config,'tester',table.tester).model,null);
});

test('reading a workspace migrates in memory and sync writes the upgrade down',async t=>{
 const ws=await fixture(t);
 const file=path.join(ws.state,'workspace.json');
 const stored=await readJSON(file);
 await atomicJSON(file,{...stored,schemaVersion:1,access:undefined,assignments:undefined});
 const reopened=await resolveWorkspace(ws.root);
 assert.equal(reopened.storedVersion,1);assert.equal(reopened.migrated,true);assert.equal(reopened.config.access,'scoped');
 assert.equal((await readJSON(file)).schemaVersion,1,'reading a workspace must not rewrite it');
 await syncWorkspace(reopened);
 assert.equal((await readJSON(file)).schemaVersion,CONFIG_VERSION);
});

test('in approval mode a writer waits for a permit, and spends it once',async t=>{
 const ws=await fixture(t);
 const tree=await createWorktree(ws,'T2');
 const write=packet({taskId:'T2',role:'implementer',authority:'workspace-write',worktree:path.relative(ws.root,tree.path)});
 await assert.rejects(submit(ws,write,{start:false}),/claudex approve T2/);
 await assert.rejects(approve(ws,{taskId:'T2',reason:'short'}),/records why/);
 await approve(ws,{taskId:'T2',reason:'Reviewed the plan and the scope of the writer'});
 const { jobId }=await submit(ws,write,{start:false});
 assert.ok(jobId);
 assert.ok(await readApproval(ws,'T2'),'the permit is spent by the worker, not by queueing');
});

test('a scoped installation lets the same writer run without a permit',async t=>{
 const ws=await fixture(t);
 ws.config.access='scoped';
 const tree=await createWorktree(ws,'T3');
 const { jobId }=await submit(ws,packet({taskId:'T3',role:'implementer',authority:'workspace-write',worktree:path.relative(ws.root,tree.path)}),{start:false});
 assert.ok(jobId);
});

test('the setup window refuses a folder that is not a repository of its own',async t=>{
 const ws=await fixture(t);
 assert.match(await projectProblem(ws.root,''),/Name the folder/);
 assert.match(await projectProblem(ws.root,'.'),/cannot be the managed project/);
 assert.match(await projectProblem(ws.root,'missing'),/does not exist/);
 await fs.mkdir(path.join(ws.root,'plain'),{recursive:true});
 assert.match(await projectProblem(ws.root,'plain'),/not a Git root/);
 assert.equal(await projectProblem(ws.root,'project'),null);
});

test('the setup window collects a full configuration and shows it back',async t=>{
 const ws=await fixture(t);
 const { io, written }=scripted([
  'project','generic','full',            // project, profile, access
  'claude','opus','codex','gpt-6-astra', // executables and provider defaults
  '',                                    // lead: keep the default
  'codex/gpt-5.6-terra@max',             // architect: another provider, model and effort
  'skip',                                // keep every remaining role
  'yes',
 ]);
 const choices=await runSetup(io,{root:ws.root,roles:await roles()});
 assert.equal(choices.project,'project');
 assert.equal(choices.access,'full');
 assert.deepEqual(choices.models,{claude:'opus',codex:'gpt-6-astra'});
 // Only differences from the role default are stored; `high` is already the
 // architect's effort, so asking for `max` is what gets recorded.
 assert.deepEqual(choices.assignments.architect,{provider:'codex',model:'gpt-5.6-terra',effort:'max'});
 const shown=written.join('');
 assert.match(shown,/Managed project/);assert.match(shown,/\.local\/claudex\//);
 assert.match(shown,/approval.*one-shot|one-shot/s);
 assert.match(summary(choices),/architect: provider=codex model=gpt-5\.6-terra effort=max/);
});

test('the setup window says no instead of writing a configuration that cannot work',async t=>{
 const ws=await fixture(t);
 const { io, written }=scripted(['','','codex','skip']);
 const assignments=await chooseAssignments(io,{roles:await roles(),config:defaultConfig({project:'p'}),current:{}});
 // The third role is `implementer`, which writes. Codex cannot serve it, and the
 // window says so instead of storing a configuration that fails at run time.
 assert.match(written.join(''),/codex serves read-only roles only/);
 assert.ok(!assignments.implementer);
});

test('a declined summary writes nothing',async t=>{
 const ws=await fixture(t);
 const { io }=scripted(['project','generic','approval','claude','','codex','gpt-6-astra','skip','no']);
 assert.equal(await runSetup(io,{root:ws.root,roles:await roles()}),null);
});

test('native role definitions follow the installation, not the shipped table',async t=>{
 const ws=await fixture(t);
 const claudeArchitect=path.join(ws.root,'.claude','agents','architect.md');
 const codexArchitect=path.join(ws.root,'.codex','agents','architect.toml');
 assert.ok(await fs.readFile(claudeArchitect,'utf8'));
 // The installation moves the architect to the other provider. A managed job and
 // an interactive session must not disagree about who answers for the role.
 ws.config.assignments={architect:{provider:'codex',model:'gpt-5.6-terra',effort:'max'}};
 await syncWorkspace(ws);
 const written=await fs.readFile(codexArchitect,'utf8');
 assert.match(written,/model = "gpt-5\.6-terra"/);
 assert.match(written,/model_reasoning_effort = "max"/);
 await assert.rejects(fs.readFile(claudeArchitect,'utf8'),/ENOENT/);
});

test('a role moved to claude without a model leaves the choice to the client',async t=>{
 const ws=await fixture(t);
 ws.config.assignments={auditor:{provider:'claude'}};
 ws.config.models={...ws.config.models,claude:null};
 await syncWorkspace(ws);
 const written=await fs.readFile(path.join(ws.root,'.claude','agents','auditor.md'),'utf8');
 assert.ok(!/^model:/m.test(written),'no model line rather than a made-up one');
 assert.match(written,/effort: high/);
});
