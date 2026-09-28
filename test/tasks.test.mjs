import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initTask, loadTask, checkTask, validateContract, validateTaskPacket, verifyTask, recordTask, convergeTask, checkEvidenceFor } from '../src/tasks.mjs';
import { atomicJSON, snapshot, runtimeDigest } from '../src/io.mjs';
import { doctor } from '../src/doctor.mjs';
import { classifyProviderFailure, submit } from '../src/jobs.mjs';
import { fileURLToPath } from 'node:url';

const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true});
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'claudex-task-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,'project'),state=path.join(root,'.local','claudex');
  await fs.mkdir(project,{recursive:true});
  await fs.mkdir(state,{recursive:true});
  git(project,'init','-b','main');
  git(project,'config','core.autocrlf','false');
  await fs.writeFile(path.join(project,'app.txt'),'baseline\n');
  git(project,'add','.');
  git(project,'-c','user.name=Task test','-c','user.email=test@invalid','commit','-m','baseline');
  const ws={root,project,state,config:{schemaVersion:2,project:'project',profile:'generic',access:'scoped',maxWorkers:2,models:{},assignments:{},executables:{},obsidian:{}}};
  await initTask(ws,{taskId:'feature',goal:'Change the app behavior',kind:'feature'});
  const loaded=await loadTask(ws,'feature');
  const contract={...loaded.contract,paths:['app.txt'],nonGoals:[],decisions:[],
    criteria:[{id:'behavior',text:'App behavior is checked',requires:['automated']}],
    checks:[{id:'check',criteria:['behavior'],command:process.execPath,args:['-e','console.log("verified")']}],
    tasks:[{id:'change',text:'Implement app behavior',criteria:['behavior'],dependsOn:[]}],
  };
  await atomicJSON(loaded.file,contract);
  return {ws,contract,file:loaded.file,project,root};
}

test('draft is UNKNOWN and init cannot overwrite it',async t=>{
  const {ws}=await fixture(t);
  await initTask(ws,{taskId:'draft',goal:'Unspecified change'});
  assert.equal((await checkTask(ws,'draft')).ready,false);
  assert.equal((await convergeTask(ws,'draft')).status,'UNKNOWN');
  await assert.rejects(()=>initTask(ws,{taskId:'draft',goal:'Replacement'}));
  await assert.rejects(()=>loadTask(ws,'../outside'));
});

test('contract validation rejects unmapped criteria, invalid paths and cycles',async t=>{
  const {contract}=await fixture(t);
  assert.doesNotThrow(()=>validateContract(contract));
  for(const paths of [[],['.'],['../private'],['/private'],['src/../../private'],['C:\\private']]) {
    assert.throws(()=>validateContract({...contract,paths}),`paths ${JSON.stringify(paths)}`);
  }
  assert.throws(()=>validateContract({...contract,tasks:[]}));
  assert.throws(()=>validateContract({...contract,checks:[]}));
  assert.throws(()=>validateContract({...contract,criteria:[...contract.criteria,...contract.criteria]}));
  assert.throws(()=>validateContract({...contract,tasks:[{...contract.tasks[0],dependsOn:['change']}]}));
  assert.throws(()=>validateContract({...contract,tasks:[{...contract.tasks[0],dependsOn:['missing']}]}));
  assert.throws(()=>validateContract({...contract,checks:[{...contract.checks[0],criteria:['unknown']}]}));
});

test('automated check yields inspectable evidence and convergence',async t=>{
  const {ws}=await fixture(t);
  assert.equal((await checkTask(ws,'feature')).ready,true);
  assert.equal((await convergeTask(ws,'feature')).status,'UNKNOWN');
  const evidence=await verifyTask(ws,'feature','check');
  assert.equal(evidence.status,'PASS');
  assert.match(await fs.readFile(path.resolve(ws.root,evidence.artifact),'utf8'),/verified/);
  const report=await convergeTask(ws,'feature');
  assert.equal(report.status,'PASS');
  assert.equal(report.criteria.find(c=>c.id==='behavior').status,'PASS');
  assert.equal(JSON.parse(await fs.readFile(path.join(ws.state,'tasks','feature','convergence.json'),'utf8')).status,'PASS');
});

test('new failure overrides an earlier successful run without changing the contract',async t=>{
  const {ws,contract,file,root}=await fixture(t);
  const switchFile=path.join(root,'fail-switch');
  contract.checks[0].args=['-e',`if(require('node:fs').existsSync(${JSON.stringify(switchFile)})){console.error('original symptom');process.exit(3)};console.log('ok')`];
  await atomicJSON(file,contract);
  assert.equal((await verifyTask(ws,'feature','check')).status,'PASS');
  await fs.writeFile(switchFile,'fail');
  const evidence=await verifyTask(ws,'feature','check');
  assert.equal(evidence.status,'FAIL');
  assert.match(await fs.readFile(path.resolve(root,evidence.artifact),'utf8'),/original symptom/);
  assert.equal((await convergeTask(ws,'feature')).status,'FAIL');
});

test('source, configuration and specification changes invalidate evidence',async t=>{
  const {ws,project,file,contract}=await fixture(t);
  await verifyTask(ws,'feature','check');
  await fs.writeFile(path.join(project,'app.txt'),'changed\n');
  assert.equal((await convergeTask(ws,'feature')).status,'UNKNOWN');
  await verifyTask(ws,'feature','check');
  assert.equal((await convergeTask(ws,'feature')).status,'PASS');
  ws.config.maxWorkers=3;
  assert.equal((await convergeTask(ws,'feature')).status,'UNKNOWN');
  await verifyTask(ws,'feature','check');
  await atomicJSON(file,{...contract,goal:'A different intended behavior'});
  assert.equal((await convergeTask(ws,'feature')).status,'UNKNOWN');
});

test('tampered or missing log cannot pass',async t=>{
  const {ws}=await fixture(t);
  const e=await verifyTask(ws,'feature','check');
  await fs.writeFile(path.resolve(ws.root,e.artifact),'changed evidence');
  assert.equal((await convergeTask(ws,'feature')).status,'UNKNOWN');
  await fs.unlink(path.resolve(ws.root,e.artifact));
  assert.equal((await convergeTask(ws,'feature')).status,'UNKNOWN');
});

test('mutation during check is stale even if command exits zero',async t=>{
  const {ws,contract,file}=await fixture(t);
  contract.checks[0].args=['-e',"require('node:fs').writeFileSync('app.txt','changed during check')"];
  await atomicJSON(file,contract);
  const e=await verifyTask(ws,'feature','check');
  assert.notEqual(e.before.digest,e.after.digest);
  assert.equal((await convergeTask(ws,'feature')).status,'UNKNOWN');
});

test('scope includes untracked and committed changes, ignores only untracked harness pointers',async t=>{
  const {ws,project}=await fixture(t);
  await fs.writeFile(path.join(project,'AGENTS.md'),'harness pointer');
  await verifyTask(ws,'feature','check');
  assert.equal((await convergeTask(ws,'feature')).status,'PASS');
  await fs.writeFile(path.join(project,'unrelated.txt'),'other work');
  await verifyTask(ws,'feature','check');
  assert.equal((await convergeTask(ws,'feature')).status,'FAIL');
  git(project,'add','unrelated.txt');
  git(project,'-c','user.name=Task test','-c','user.email=test@invalid','commit','-m','outside scope');
  await verifyTask(ws,'feature','check');
  assert.equal((await convergeTask(ws,'feature')).status,'FAIL');
});

test('manual observations require existing artifact and explicit current provenance',async t=>{
  const {ws,contract,file}=await fixture(t);
  contract.criteria[0].requires=['automated','ui'];
  await atomicJSON(file,contract);
  await verifyTask(ws,'feature','check');
  assert.equal((await convergeTask(ws,'feature')).status,'UNKNOWN');
  const artifact='.local/claudex/artifacts/observed.txt';
  await fs.mkdir(path.dirname(path.join(ws.root,artifact)),{recursive:true});
  await fs.writeFile(path.join(ws.root,artifact),'Explicit synthetic observation fixture, not real UI evidence.');
  const observation={criterionId:'behavior',kind:'ui',status:'PASS',artifact,note:'Test observation',observer:'test-observer',sourceDigest:(await snapshot(ws.project)).digest,configurationDigest:await runtimeDigest(ws),contractDigest:(await loadTask(ws,'feature')).contractDigest};
  await assert.rejects(()=>recordTask(ws,'feature',{...observation,sourceDigest:'0'.repeat(64)}));
  await assert.rejects(()=>recordTask(ws,'feature',{...observation,artifact:'project/app.txt'}));
  await assert.rejects(()=>recordTask(ws,'feature',{...observation,observer:''}));
  await assert.rejects(()=>recordTask(ws,'feature',{...observation,kind:'automated'}));
  const e=await recordTask(ws,'feature',observation);
  assert.equal(e.attested,true);
  assert.equal((await convergeTask(ws,'feature')).status,'PASS');
  await recordTask(ws,'feature',{...observation,status:'UNKNOWN',note:'Observation inconclusive'});
  assert.equal((await convergeTask(ws,'feature')).status,'UNKNOWN');
});

test('worktree must belong to the managed repository',async t=>{
  const {ws,root}=await fixture(t);
  const foreign=path.join(root,'foreign');
  await fs.mkdir(foreign);
  git(foreign,'init','-b','main');
  await fs.writeFile(path.join(foreign,'file'),'other');
  git(foreign,'add','.');
  git(foreign,'-c','user.name=Task test','-c','user.email=test@invalid','commit','-m','foreign');
  await assert.rejects(()=>initTask(ws,{taskId:'foreign',goal:'Should not bind foreign repo',worktree:'foreign'}));
});

test('every mapped automated check must pass',async t=>{
  const {ws,contract,file}=await fixture(t);
  contract.checks.push({id:'another',criteria:['behavior'],command:process.execPath,args:['-e','process.exit(7)']});
  await atomicJSON(file,contract);
  await verifyTask(ws,'feature','check');
  assert.equal((await convergeTask(ws,'feature')).status,'UNKNOWN');
  await verifyTask(ws,'feature','another');
  await verifyTask(ws,'feature','check');
  assert.equal((await convergeTask(ws,'feature')).status,'FAIL');
});

test('contract gate refuses unbound writers before creating a job',async t=>{
  const {ws}=await fixture(t);
  ws.config.workflow={requireContract:true};
  const packet={taskId:'bounded',role:'implementer',authority:'workspace-write',mode:'snapshot',goal:'Implement bounded behavior',worktree:'.local/claudex/worktrees/bounded',paths:['app.txt'],criteria:[{id:'behavior',text:'Verify app behavior'}]};
  await assert.rejects(()=>submit(ws,packet,{start:false}),/contractId/);
  assert.equal(await fs.access(path.join(ws.state,'jobs')).then(()=>true,()=>false),false);
  await assert.rejects(()=>validateTaskPacket(ws,{...packet,contractId:'feature'}),/worktree/);
  const readPacket={...packet,authority:'read-only',role:'auditor',worktree:null,contractId:'feature'};
  assert.equal((await validateTaskPacket(ws,readPacket)).id,'feature');
  assert.equal((await validateTaskPacket(ws,{...readPacket,worktree:undefined})).id,'feature');
  await assert.rejects(()=>validateTaskPacket(ws,{...readPacket,paths:['unrelated.txt']}),/scope/);
  await assert.rejects(()=>validateTaskPacket(ws,{...readPacket,criteria:[{id:'missing'}]}),/criteria/);
  assert.equal(await validateTaskPacket(ws,{...readPacket,contractId:undefined}),null);
});

test('CLI check/verify/converge produce meaningful exit codes',async t=>{
  const {ws}=await fixture(t);
  await atomicJSON(path.join(ws.root,'.claudex.json'),{schemaVersion:1,state:'.local/claudex'});
  await atomicJSON(path.join(ws.state,'workspace.json'),ws.config);
  const cli=fileURLToPath(new URL('../bin/claudex.mjs',import.meta.url));
  const run=(...args)=>{
    try { return {code:0,result:JSON.parse(execFileSync(process.execPath,[cli,...args,'--workspace',ws.root],{encoding:'utf8',windowsHide:true}))}; }
    catch(error) { return {code:error.status,result:JSON.parse(error.stdout)}; }
  };
  assert.equal(run('task','check','feature').code,0);
  assert.equal(run('task','converge','feature').code,1);
  assert.equal(run('task','verify','feature','--check','check').code,0);
  assert.equal(run('task','converge','feature').result.status,'PASS');
  await initTask(ws,{taskId:'empty',goal:'Draft behavior'});
  assert.equal(run('task','check','empty').code,1);
  assert.equal(run('task','converge','empty').result.status,'UNKNOWN');
});

test('doctor exposes recorded unavailability even when both CLI binaries work',async t=>{
  const {ws}=await fixture(t);
  ws.config.executables={codex:process.execPath,claude:process.execPath};
  await atomicJSON(path.join(ws.state,'generated-files.json'),{});
  await atomicJSON(path.join(ws.state,'delegation.json'),{schemaVersion:1,providers:{codex:{available:false,reason:'Recorded provider failure'}},open:[],history:[]});
  const result=await doctor(ws);
  assert.equal(result.checks.find(c=>c.name==='codex').status,'PASS');
  assert.equal(result.checks.find(c=>c.name==='delegation').status,'FAIL');
  assert.equal(result.ok,false);
  assert.equal(classifyProviderFailure("Can't reach server ENOTFOUND",'claude').kind,'NETWORK');
});

test('editing the baseline cannot conceal out-of-scope commits',async t=>{
  const {ws,contract,file,project}=await fixture(t);
  await fs.writeFile(path.join(project,'outside.txt'),'unauthorized scope');
  git(project,'add','outside.txt');
  git(project,'-c','user.name=Task test','-c','user.email=test@invalid','commit','-m','outside');
  contract.base={head:git(project,'rev-parse','HEAD').trim(),digest:'0'.repeat(64),fileCount:2};
  await atomicJSON(file,contract);
  assert.equal((await checkTask(ws,'feature')).ready,false);
});

test('an old manual observation cannot acquire a new specification digest',async t=>{
  const {ws,contract,file}=await fixture(t);
  contract.criteria[0].requires=['source'];contract.checks=[];
  await atomicJSON(file,contract);
  const artifact='.local/claudex/artifacts/source.txt';
  await fs.mkdir(path.dirname(path.join(ws.root,artifact)),{recursive:true});
  await fs.writeFile(path.join(ws.root,artifact),'Observation of specification A');
  const observation={criterionId:'behavior',kind:'source',status:'PASS',artifact,note:'Observed spec A',observer:'test-observer',sourceDigest:(await snapshot(ws.project)).digest,configurationDigest:await runtimeDigest(ws),contractDigest:(await loadTask(ws,'feature')).contractDigest};
  contract.criteria[0].text='Different behavior required by specification B';
  await atomicJSON(file,contract);
  await assert.rejects(()=>recordTask(ws,'feature',observation));
});

test('configuration edited on disk during a check makes evidence stale',async t=>{
  const {ws,contract,file}=await fixture(t);
  const configFile=path.join(ws.state,'workspace.json');
  await atomicJSON(configFile,ws.config);
  contract.checks[0].args=['-e',`const fs=require('node:fs'),p=${JSON.stringify(configFile)};const c=JSON.parse(fs.readFileSync(p));c.maxWorkers=3;fs.writeFileSync(p,JSON.stringify(c))`];
  await atomicJSON(file,contract);
  assert.equal((await verifyTask(ws,'feature','check')).freshness,'STALE');
  assert.equal((await convergeTask(ws,'feature')).status,'UNKNOWN');
});

test('a reviewer receives the latest check run, CURRENT only on its own snapshot',async t=>{
  const {ws,project}=await fixture(t);
  await verifyTask(ws,'feature','check');
  const second=await verifyTask(ws,'feature','check');
  const [check]=await checkEvidenceFor(ws,'feature',(await snapshot(project)).digest);
  assert.equal(check.evidenceId,second.id);
  assert.deepEqual([check.checkId,check.status,check.freshness,check.logState],['check','PASS','CURRENT','OK']);
  assert.match(check.log,/verified/);
  await fs.writeFile(path.join(project,'app.txt'),'changed\n');
  assert.equal((await checkEvidenceFor(ws,'feature',(await snapshot(project)).digest))[0].freshness,'STALE');
  await fs.appendFile(path.resolve(ws.root,second.artifact),'forged PASS\n');
  const [tampered]=await checkEvidenceFor(ws,'feature',(await snapshot(project)).digest);
  assert.equal(tampered.logState,'TAMPERED');
  assert.equal(tampered.log,null);
  assert.deepEqual(await checkEvidenceFor(ws,null,'x'),[]);
});
