import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initTask, loadTask, verifyTask, convergeTask, validateContract } from '../src/tasks.mjs';
import { atomicJSON } from '../src/io.mjs';

const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true});
// A project whose build rewrites a tracked bundle and reads a dependency from an
// ignored node_modules, the way an Obsidian plugin's esbuild step does.
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'claudex-isolate-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,'project'),state=path.join(root,'.local','claudex');
  await fs.mkdir(path.join(project,'node_modules','dep'),{recursive:true});
  await fs.mkdir(state,{recursive:true});
  git(project,'init','-b','main');
  git(project,'config','core.autocrlf','false');
  await fs.writeFile(path.join(project,'.gitignore'),'node_modules\n');
  await fs.writeFile(path.join(project,'node_modules','dep','value.txt'),'dependency\n');
  await fs.writeFile(path.join(project,'src.txt'),'source-v1\n');
  await fs.writeFile(path.join(project,'bundle.js'),'built from source-v1\n');
  await fs.writeFile(path.join(project,'build.js'),[
    "const fs=require('node:fs');",
    "const dep=fs.readFileSync('node_modules/dep/value.txt','utf8');",
    "if(dep!=='dependency\\n')process.exit(4);",
    "fs.writeFileSync('bundle.js','built from '+fs.readFileSync('src.txt','utf8'));",
  ].join('\n'));
  git(project,'add','.');
  git(project,'-c','user.name=Isolate test','-c','user.email=test@invalid','commit','-m','baseline');
  const ws={root,project,state,config:{schemaVersion:2,project:'project',profile:'generic',access:'scoped',maxWorkers:2,models:{},assignments:{},executables:{},obsidian:{}}};
  await initTask(ws,{taskId:'bundle',goal:'Bundle reproduces source',kind:'maintenance'});
  const loaded=await loadTask(ws,'bundle');
  const contract={...loaded.contract,paths:['src.txt','bundle.js'],nonGoals:[],decisions:[],
    criteria:[{id:'bundle',text:'Tracked bundle equals a fresh build',requires:['automated']}],
    tasks:[{id:'build',text:'Build',criteria:['bundle'],dependsOn:[]}],
    checks:[{id:'build',criteria:['bundle'],command:process.execPath,args:['build.js'],isolate:true,
      reproduces:[{output:'bundle.js',against:['bundle.js']}]}],
  };
  await atomicJSON(loaded.file,contract);
  return {ws,project,root,contract,file:loaded.file};
}

test('an isolated build leaves the checkout untouched and its evidence current',async t=>{
  const {ws,project}=await fixture(t);
  await fs.writeFile(path.join(project,'bundle.js'),'stale bundle\n');
  const before=await fs.readFile(path.join(project,'bundle.js'),'utf8');
  const e=await verifyTask(ws,'bundle','build');
  assert.equal(await fs.readFile(path.join(project,'bundle.js'),'utf8'),before,'the checkout bundle was not rewritten');
  assert.equal(e.freshness,'CURRENT');
  assert.equal(e.before.digest,e.after.digest);
});

test('reproduction compares the fresh output with the tracked file',async t=>{
  const {ws,project}=await fixture(t);
  const pass=await verifyTask(ws,'bundle','build');
  assert.equal(pass.status,'PASS');
  assert.equal(pass.reproduction[0].result,'MATCH');
  assert.equal((await convergeTask(ws,'bundle')).status,'PASS');
  // An uncommitted source edit is part of the snapshot being tested; the tracked
  // bundle no longer matches what that source builds.
  await fs.writeFile(path.join(project,'src.txt'),'source-v2\n');
  const fail=await verifyTask(ws,'bundle','build');
  assert.equal(fail.status,'FAIL');
  assert.equal(fail.reproduction[0].result,'DIFFER');
  assert.equal(fail.freshness,'CURRENT');
});

// The build exits 4 unless it reads the dependency, so this fails without the link.
// Node's fs.rm unlinks a junction rather than following it; the survival check
// guards against a regression to another deleter, it is not a proof on its own.
test('dependencies are reached through a link and the shared copy survives cleanup',async t=>{
  const {ws,project}=await fixture(t);
  const e=await verifyTask(ws,'bundle','build');
  assert.equal(e.status,'PASS','the dependency was reachable through the link');
  assert.equal(await fs.readFile(path.join(project,'node_modules','dep','value.txt'),'utf8'),'dependency\n');
  const leftovers=(await fs.readdir(os.tmpdir())).filter(n=>n.startsWith('claudex-isolated-'));
  for(const n of leftovers) {
    const stat=await fs.stat(path.join(os.tmpdir(),n)).catch(()=>null);
    assert.ok(!stat||Date.now()-stat.mtimeMs>60000,`isolated copy ${n} was not removed`);
  }
});

test('reproduction targets are bounded and require isolation',async t=>{
  const {contract}=await fixture(t);
  const check=contract.checks[0];
  const withCheck=c=>({...contract,checks:[{...check,...c}]});
  assert.doesNotThrow(()=>validateContract(withCheck({reproduces:[{output:'bundle.js',against:['bundle.js','@workspace/vault/plugin/main.js']}]})));
  assert.throws(()=>validateContract(withCheck({isolate:false})),/isolat/);
  assert.throws(()=>validateContract(withCheck({reproduces:[{output:'../escape.js',against:['bundle.js']}]})));
  assert.throws(()=>validateContract(withCheck({reproduces:[{output:'bundle.js',against:['@workspace/../outside.js']}]})));
  assert.throws(()=>validateContract(withCheck({reproduces:[{output:'bundle.js',against:[]}]})));
});

test('a workspace target is compared too, so a deployed copy can be checked',async t=>{
  const {ws,contract,file,root}=await fixture(t);
  await fs.mkdir(path.join(root,'vault'),{recursive:true});
  await fs.writeFile(path.join(root,'vault','main.js'),'built from source-v1\n');
  contract.checks[0].reproduces=[{output:'bundle.js',against:['bundle.js','@workspace/vault/main.js','@workspace/vault/missing.js']}];
  await atomicJSON(file,contract);
  const e=await verifyTask(ws,'bundle','build');
  assert.deepEqual(e.reproduction.map(r=>r.result),['MATCH','MATCH','MISSING']);
  assert.equal(e.status,'FAIL');
});

test('eol:ignore compares text content across a CRLF checkout, and says so',async t=>{
  const {ws,project,contract,file}=await fixture(t);
  await fs.writeFile(path.join(project,'bundle.js'),'built from source-v1\r\n');
  const strict=await verifyTask(ws,'bundle','build');
  assert.equal(strict.reproduction[0].result,'DIFFER');
  contract.checks[0].reproduces=[{output:'bundle.js',against:['bundle.js'],eol:'ignore'}];
  await atomicJSON(file,contract);
  const relaxed=await verifyTask(ws,'bundle','build');
  assert.equal(relaxed.reproduction[0].result,'MATCH');
  assert.equal(relaxed.reproduction[0].normalized,true);
  assert.equal(relaxed.status,'PASS');
});
