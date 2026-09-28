import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assert, atomicJSON, contained, exists, git, inside, readJSON, runtimeDigest, sha, snapshot, withLock } from './io.mjs';
import { runCommand } from './process.mjs';
import { compareReproduction, withIsolatedCopy } from './isolate.mjs';
import { migrateConfig } from './config.mjs';
import { readPrinciples } from './setup.mjs';

const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,70}$/;
const HASH=/^[a-f0-9]{64}$/;
const KINDS=['automated','source','ui','persistence','review'];
const STATES=['PASS','FAIL','UNKNOWN'];
const nonempty=value=>typeof value==='string'&&Boolean(value.trim());
const strings=value=>Array.isArray(value)&&value.every(nonempty);
const id=value=>assert(typeof value==='string'&&ID.test(value),'Invalid task or criterion ID');
const relative=value=>nonempty(value)&&!path.posix.isAbsolute(value)&&!path.win32.isAbsolute(value)&&!/[\x00-\x1f:*?"<>|]/.test(value)&&!value.split(/[\\/]/).some(p=>!p||p==='.'||p==='..');
const norm=value=>value.replaceAll('\\','/');
const covered=(file,scope)=>scope.some(p=>norm(file)===norm(p)||norm(file).startsWith(`${norm(p)}/`));

export function validateContract(c) {
  assert(c&&c.schemaVersion===1,'Unsupported task contract version');
  id(c.taskId);
  assert(['feature','bug','maintenance'].includes(c.kind),'Unknown task kind');
  assert(nonempty(c.goal),'Missing task goal');
  assert(strings(c.nonGoals)&&strings(c.decisions),'nonGoals and decisions must be string arrays');
  assert(c.base&&/^[a-f0-9]{40,64}$/.test(c.base.head)&&HASH.test(c.base.digest),'Missing base snapshot');
  assert(c.worktree===null||relative(c.worktree),'Invalid worktree path');
  assert(strings(c.paths)&&c.paths.length&&c.paths.every(relative),'paths must contain bounded relative scopes');
  for(const key of ['criteria','checks','tasks']) {
    assert(Array.isArray(c[key]),`${key} must be an array`);
    for(const entry of c[key]) { assert(entry&&typeof entry==='object',`Invalid ${key} entry`); id(entry.id); }
    assert(new Set(c[key].map(e=>e.id)).size===c[key].length,`Duplicate ${key} ID`);
  }
  assert(c.criteria.length&&c.tasks.length,'Draft: criteria and tasks are required');
  const criteria=new Set(c.criteria.map(e=>e.id));
  for(const item of c.criteria) {
    assert(nonempty(item.text)&&Array.isArray(item.requires)&&item.requires.length,'Criterion needs text and evidence kinds');
    assert(item.requires.every(k=>KINDS.includes(k))&&new Set(item.requires).size===item.requires.length,'Invalid or duplicate evidence kind');
  }
  for(const item of [...c.tasks,...c.checks]) {
    assert(strings(item.criteria)&&item.criteria.length&&item.criteria.every(k=>criteria.has(k)),'Unknown or missing criterion mapping');
  }
  for(const check of c.checks) {
    assert(nonempty(check.command)&&Array.isArray(check.args)&&check.args.every(a=>typeof a==='string'),'Check needs command and string args');
    assert(check.timeoutMs===undefined||(Number.isInteger(check.timeoutMs)&&check.timeoutMs>0&&check.timeoutMs<=900000),'Check timeout must be 1..900000 ms');
    assert(check.criteria.every(k=>c.criteria.find(e=>e.id===k).requires.includes('automated')),'Checks must map to automated criteria');
    assert(check.isolate===undefined||typeof check.isolate==='boolean','isolate must be boolean');
    if(check.reproduces!==undefined) {
      // A reproduction compares a build's output with a tracked file; run in the
      // checkout, that build would overwrite the very file it is compared with.
      assert(check.isolate===true,'reproduces requires an isolated check');
      assert(Array.isArray(check.reproduces)&&check.reproduces.length,'reproduces must be a nonempty array');
      for(const r of check.reproduces) {
        assert(r&&relative(r.output)&&Array.isArray(r.against)&&r.against.length,'Each reproduction needs an output and targets');
        assert(r.eol===undefined||r.eol==='ignore','eol may only be "ignore"');
        assert(r.against.every(a=>typeof a==='string'&&relative(a.startsWith('@workspace/')?a.slice(11):a)),'Reproduction targets must be bounded relative paths');
      }
    }
  }
  const tasks=new Map(c.tasks.map(e=>[e.id,e]));
  for(const task of c.tasks) assert(nonempty(task.text)&&strings(task.dependsOn)&&task.dependsOn.every(k=>tasks.has(k)),'Task needs text and known dependencies');
  const visited=new Set(),visiting=new Set();
  function visit(key) {
    assert(!visiting.has(key),'Cyclic task dependencies');
    if(visited.has(key))return;
    visiting.add(key);
    tasks.get(key).dependsOn.forEach(visit);
    visiting.delete(key);visited.add(key);
  }
  for(const key of tasks.keys())visit(key);
  for(const criterion of c.criteria) {
    assert(c.tasks.some(t=>t.criteria.includes(criterion.id)),`Unmapped criterion ${criterion.id}`);
    if(criterion.requires.includes('automated'))assert(c.checks.some(t=>t.criteria.includes(criterion.id)),`Missing check for ${criterion.id}`);
  }
  return c;
}

async function taskDir(ws,taskId) {
  id(taskId);
  await contained(ws.root,ws.state);
  return contained(ws.state,path.join(ws.state,'tasks',taskId));
}
async function taskRepo(ws,worktree) {
  assert(worktree===null||relative(worktree),'Invalid worktree path');
  const repo=worktree?await contained(ws.root,path.resolve(ws.root,worktree)):ws.project;
  if(worktree) {
    const common=async p=>path.resolve((await git(p,['rev-parse','--path-format=absolute','--git-common-dir'])).trim());
    assert(await common(repo)===await common(ws.project),'Worktree belongs to another repository');
    assert(path.resolve((await git(repo,['rev-parse','--show-toplevel'])).trim())===path.resolve(repo),'Task must bind the worktree root');
  }
  assert(!inside(repo,ws.state),'Task state must be outside the source checkout');
  return repo;
}
export async function initTask(ws,{taskId,kind='feature',goal,worktree=null}) {
  assert(nonempty(goal),'Missing task goal');
  assert(['feature','bug','maintenance'].includes(kind),'Unknown task kind');
  const dir=await taskDir(ws,taskId),repo=await taskRepo(ws,worktree);
  const contract={schemaVersion:1,taskId,kind,goal,nonGoals:[],decisions:[],base:await snapshot(repo),worktree,paths:[],criteria:[],checks:[],tasks:[]};
  const file=await contained(ws.state,path.join(dir,'contract.json'));
  const basisFile=await contained(ws.state,path.join(dir,'basis.json'));
  await withLock(ws.state,async()=>{
    assert(!(await exists(file))&&!(await exists(basisFile)),'Task already exists; init never overwrites a contract or its basis');
    await atomicJSON(basisFile,{schemaVersion:1,taskId,base:contract.base,worktree});
    await atomicJSON(file,contract);
  });
  return {taskId,file,ready:false,contract};
}
export async function loadTask(ws,taskId) {
  const dir=await taskDir(ws,taskId),file=await contained(ws.state,path.join(dir,'contract.json'));
  const contract=await readJSON(file);
  assert(contract.taskId===taskId,'Task identity mismatch');
  const basis=await readJSON(await contained(ws.state,path.join(dir,'basis.json')));
  assert(basis.schemaVersion===1&&basis.taskId===taskId&&basis.worktree===contract.worktree&&
    ['head','digest','fileCount'].every(k=>basis.base?.[k]===contract.base?.[k]),'Task base or worktree changed; create a new task for a new baseline');
  return {dir,file,contract,repo:await taskRepo(ws,contract.worktree),contractDigest:sha(JSON.stringify(contract))};
}
async function readyTask(ws,taskId) {
  const loaded=await loadTask(ws,taskId);
  validateContract(loaded.contract);
  for(const p of loaded.contract.paths)await contained(loaded.repo,path.resolve(loaded.repo,p));
  await git(loaded.repo,['merge-base','--is-ancestor',loaded.contract.base.head,'HEAD']);
  return loaded;
}
/**
 * A consistency pass over a valid contract, after Spec Kit's analyze: the
 * contract can be well-formed and still promise something no check will ever
 * show. Warnings never block; they are what a reviewer would otherwise find
 * after the work is done. Pure: principles come from the caller.
 */
const VAGUE=/\b(fast|quick(?:ly)?|robust|intuitive|user-friendly|properly|correctly|appropriate(?:ly)?|seamless(?:ly)?|clean|nice|as expected|works?)\b|(?:^|[\s,.(])(быстро|корректно|правильно|удобно|красиво|нормально|как ожидается|работает)(?=$|[\s,.)])/i;
// Angle brackets are not placeholders here: decisions quote markup and CLI syntax.
const PLACEHOLDER=/\b(TODO|TBD|FIXME|TKTK)\b|\?\?\?/;
// A file scope is code by its extension; a directory scope (no dot) by its name.
const CODE_PATH=/\.(?:[cm]?[jt]sx?|svelte|vue|swift|kt|py|rs|go)$|^(?:[^.]*\/)?(?:src|lib|app|tests?|__tests__)(?:\/[^.]*)?$/;
// Contracts often call the tool a script wraps (node node_modules/eslint/...).
const SCRIPT_ALIASES={test:/\btest\b|jest|vitest|mocha|--test/,build:/\bbuild\b|esbuild|vite build|webpack|rollup/,lint:/\blint\b|eslint/};
const STATIC_CHECK=/lint|\btsc\b|typecheck|type-check|svelte-check|swiftlint|mypy|clippy/i;
export function analyzeContract(c,{principles=null}={}) {
  const warnings=[];
  const warn=(category,severity,summary)=>warnings.push({id:`${category[0].toUpperCase()}${warnings.filter(w=>w.category===category).length+1}`,category,severity,summary});
  const commandLine=check=>[check.command,...(check.args??[])].join(' ');
  for(const item of c.criteria) {
    if(VAGUE.test(item.text)&&!/\d/.test(item.text))warn('ambiguity','MEDIUM',`Criterion ${item.id} uses a word no check can measure: "${item.text.match(VAGUE)[0].trim()}". State what is observed instead.`);
  }
  for(const [where,text] of [['goal',c.goal],...c.criteria.map(e=>[`criterion ${e.id}`,e.text]),...c.tasks.map(e=>[`task ${e.id}`,e.text??'']),...c.decisions.map((d,i)=>[`decision ${i+1}`,d])]) {
    if(PLACEHOLDER.test(text))warn('placeholder','HIGH',`The ${where} still holds a placeholder: "${text.match(PLACEHOLDER)[0]}".`);
  }
  const seen=new Map();
  for(const item of c.criteria) {
    const key=item.text.toLowerCase().replace(/\W+/g,' ').trim();
    if(seen.has(key))warn('duplication','MEDIUM',`Criteria ${seen.get(key)} and ${item.id} say the same thing; merge them or tell them apart.`);
    else seen.set(key,item.id);
  }
  for(const item of c.criteria) {
    if(!c.tasks.some(t=>t.criteria.includes(item.id)))warn('coverage','HIGH',`No task works towards criterion ${item.id}.`);
    if(item.requires.includes('automated')&&!c.checks.some(k=>k.criteria.includes(item.id)))warn('coverage','HIGH',`Criterion ${item.id} requires automated evidence, but no check maps to it; converge can only answer UNKNOWN.`);
  }
  // A test suite can pass while strict typing fails: that once surfaced only in
  // a later contract that happened to run svelte-check.
  const code=c.paths.some(p=>CODE_PATH.test(norm(p)));
  if(code&&!c.checks.some(k=>STATIC_CHECK.test(commandLine(k))))warn('checks','HIGH','The scope changes code, but no check runs the type checker or linter; a passing test run does not show the code compiles cleanly.');
  // Only for code: a documentation contract owes no build.
  if(code&&principles?.checks) {
    for(const required of principles.checks.split(',').map(s=>s.trim()).filter(Boolean)) {
      const script=required.replace(/^npm (run )?/,'');
      const runs=SCRIPT_ALIASES[script]??{test:line=>line.includes(script)};
      if(!c.checks.some(k=>runs.test(commandLine(k))))warn('principles','MEDIUM',`The recorded principles require "${required}" before completion; no check of this contract runs it.`);
    }
  }
  return warnings;
}
export async function checkTask(ws,taskId) {
  id(taskId);
  try {
    const t=await readyTask(ws,taskId);
    const profile=await fs.readFile(path.join(ws.state,'project-profile.md'),'utf8').catch(()=>null);
    return {taskId,ready:true,errors:[],warnings:analyzeContract(t.contract,{principles:readPrinciples(profile)}),contractDigest:t.contractDigest};
  }
  catch(error) { return {taskId,ready:false,errors:[error.message]}; }
}
// Opt-in enforcement keeps old installations readable; this workspace enables it.
export async function validateTaskPacket(ws,packet) {
  if(!packet.contractId) {
    assert(packet.authority!=='workspace-write'||ws.config.workflow?.requireContract!==true,'Writing jobs require contractId; create and check a task contract first');
    return null;
  }
  const t=await readyTask(ws,packet.contractId);
  assert((packet.worktree??null)===t.contract.worktree,'Packet and contract must bind the same worktree');
  assert(packet.paths.length&&packet.paths.every(p=>relative(p)&&covered(p,t.contract.paths)),'Packet paths exceed the contract scope');
  assert(packet.criteria.every(c=>t.contract.criteria.some(expected=>expected.id===c.id)),'Packet criteria are not mapped to the contract');
  return {id:t.contract.taskId,digest:t.contractDigest,contract:t.contract};
}
async function context(ws,t) {
  const configFile=path.join(ws.state,'workspace.json');
  const config=await exists(configFile)?migrateConfig(await readJSON(configFile)).config:ws.config;
  return {source:await snapshot(t.repo),configurationDigest:await runtimeDigest({...ws,config}),contractDigest:sha(JSON.stringify(await readJSON(t.file)))};
}
async function evidenceRecords(ws,t) {
  const dir=await contained(ws.state,path.join(t.dir,'evidence'));
  if(!(await exists(dir)))return [];
  return Promise.all((await fs.readdir(dir)).filter(f=>f.endsWith('.json')).map(async f=>{
    const file=await contained(ws.state,path.join(dir,f));
    return {...await readJSON(file),file};
  }));
}
/**
 * The checks the coordinator already ran for this contract, handed to a job as
 * data. A read-only reviewer cannot run the project's tests (Codex's sandbox
 * answers jest with EPERM), and without this every such criterion came back
 * UNKNOWN. Only the latest automated run of each check is given, with the tail
 * of its log, and it is CURRENT only when it was taken on exactly the snapshot
 * the job reviews; a log whose bytes no longer match its record is withheld.
 */
export const CHECK_LOG_TAIL=12000;
export async function checkEvidenceFor(ws,contractId,sourceDigest) {
  if(!contractId)return [];
  const t=await loadTask(ws,contractId);
  const latest=new Map();
  for(const e of await evidenceRecords(ws,t)) {
    if(e.kind!=='automated'||!e.checkId)continue;
    if(!latest.has(e.checkId)||Number(e.sequence)>Number(latest.get(e.checkId).sequence))latest.set(e.checkId,e);
  }
  const out=[];
  // Source alone is not the state a run describes: a changed check command,
  // criterion or configuration makes an old PASS answer a different question.
  const now=await context(ws,t);
  for(const e of [...latest.values()].sort((a,b)=>a.checkId.localeCompare(b.checkId))) {
    const current=e.freshness==='CURRENT'&&e.before?.digest===sourceDigest&&e.after?.digest===sourceDigest&&
      e.configurationDigest===now.configurationDigest&&e.contractDigest===now.contractDigest;
    let log=null,logState='MISSING';
    try {
      const bytes=await fs.readFile(await contained(ws.state,path.resolve(ws.root,e.artifact)));
      if(sha(bytes)!==e.artifactSha256)logState='TAMPERED';
      else { const text=bytes.toString('utf8');log=text.length>CHECK_LOG_TAIL?`…${text.slice(-CHECK_LOG_TAIL)}`:text;logState='OK'; }
    } catch {}
    out.push({checkId:e.checkId,evidenceId:e.id,criteria:e.criteria??[],status:e.status,freshness:current?'CURRENT':'STALE',createdAt:e.createdAt??null,logState,log});
  }
  return out;
}
async function saveEvidence(ws,t,evidence) {
  return withLock(ws.state,async()=>{
    const records=await evidenceRecords(ws,t);
    const sequence=Math.max(0,...records.map(e=>Number(e.sequence)||0))+1;
    const file=await contained(ws.state,path.join(t.dir,'evidence',`${evidence.id}.json`));
    const result={...evidence,sequence,file};
    await atomicJSON(file,result);
    return result;
  });
}
export async function verifyTask(ws,taskId,checkId) {
  const t=await readyTask(ws,taskId),check=t.contract.checks.find(c=>c.id===checkId);
  assert(check,'Unknown check ID');
  const before=await context(ws,t),evidenceId=crypto.randomUUID();
  let status='PASS',log='',error=null,reproduction;
  const run=async cwd=>{
    try {
      const result=await runCommand(check.command,check.args,{cwd,timeout:check.timeoutMs??120000,maxBuffer:8*1024*1024});
      log=result.stdout+result.stderr;
    } catch(e) { status='FAIL';error=e.message;log=`${e.stdout??''}${e.stderr??''}\n${e.message}\n`; }
    if(check.reproduces&&status==='PASS') {
      reproduction=await compareReproduction(ws,t.repo,cwd,check.reproduces);
      if(reproduction.some(r=>r.result!=='MATCH')) { status='FAIL';error='Build output does not reproduce its targets'; }
      log+=`\nreproduction:\n${reproduction.map(r=>`${r.result} ${r.output} -> ${r.against}`).join('\n')}\n`;
    }
  };
  if(check.isolate)await withIsolatedCopy(t.repo,run);else await run(t.repo);
  const after=await context(ws,t);
  const logFile=await contained(ws.state,path.join(t.dir,'logs',`${evidenceId}.log`));
  await fs.mkdir(path.dirname(logFile),{recursive:true});
  await fs.writeFile(logFile,log,{flag:'wx',mode:0o600});
  const freshness=before.source.digest===after.source.digest&&before.configurationDigest===after.configurationDigest&&before.contractDigest===after.contractDigest?'CURRENT':'STALE';
  return saveEvidence(ws,t,{id:evidenceId,taskId,checkId,criteria:check.criteria,kind:'automated',status,freshness,error,
    ...(check.isolate?{isolated:true}:{}),...(reproduction?{reproduction}:{}),
    before:before.source,after:after.source,configurationDigest:before.configurationDigest,contractDigest:before.contractDigest,
    artifact:norm(path.relative(ws.root,logFile)),artifactSha256:sha(await fs.readFile(logFile)),createdAt:new Date().toISOString(),attested:false});
}
export async function recordTask(ws,taskId,observation) {
  const t=await readyTask(ws,taskId);
  assert(observation&&typeof observation==='object','Missing observation');
  const {criterionId,kind,status,artifact,note,observer,sourceDigest,configurationDigest,contractDigest}=observation;
  const criterion=t.contract.criteria.find(c=>c.id===criterionId);
  assert(criterion&&criterion.requires.includes(kind),'Observation does not match a required criterion kind');
  assert(KINDS.includes(kind)&&kind!=='automated','Use verify for automated evidence');
  assert(STATES.includes(status)&&nonempty(note)&&nonempty(observer),'Observation needs status, note and observer');
  assert(kind!=='review'||observer.trim().toLowerCase()!=='implementer','Implementer cannot attest their own review');
  assert(relative(artifact),'Artifact must be workspace-relative');
  const artifactRoot=await contained(ws.root,path.join(ws.state,'artifacts'));
  const artifactFile=await contained(artifactRoot,path.resolve(ws.root,artifact));
  const bytes=await fs.readFile(artifactFile);
  assert(bytes.length,'An observation needs a nonempty artifact');
  const current=await context(ws,t);
  assert(sourceDigest===current.source.digest&&configurationDigest===current.configurationDigest&&contractDigest===current.contractDigest,'Observation digests do not match current source/configuration/contract');
  return saveEvidence(ws,t,{id:crypto.randomUUID(),taskId,criteria:[criterionId],kind,status,
    before:current.source,after:current.source,configurationDigest,contractDigest,
    artifact:norm(path.relative(ws.root,artifactFile)),artifactSha256:sha(bytes),note,observer,
    attested:true,freshness:'CURRENT',createdAt:new Date().toISOString()});
}
async function evidenceState(ws,t,e,current) {
  if(!STATES.includes(e.status)||e.taskId!==t.contract.taskId)return 'Malformed evidence';
  if(e.before?.digest!==current.source.digest||e.after?.digest!==current.source.digest||e.freshness!=='CURRENT')return 'Source evidence is stale';
  if(e.configurationDigest!==current.configurationDigest||e.contractDigest!==current.contractDigest)return 'Configuration or contract changed';
  try {
    assert(relative(e.artifact),'Invalid artifact path');
    const root=e.kind==='automated'?await contained(ws.state,path.join(t.dir,'logs')):await contained(ws.root,path.join(ws.state,'artifacts'));
    const file=await contained(root,path.resolve(ws.root,e.artifact));
    if(sha(await fs.readFile(file))!==e.artifactSha256)return 'Artifact changed';
  } catch { return 'Artifact missing or outside evidence directory'; }
  return null;
}
async function scopeViolations(t) {
  const changed=(await git(t.repo,['diff','--no-renames','--name-only','-z',t.contract.base.head])).split('\0').filter(Boolean);
  const untracked=(await git(t.repo,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(f=>f&&!['AGENTS.md','CLAUDE.md'].includes(f));
  return [...new Set([...changed,...untracked])].filter(f=>!covered(f,t.contract.paths));
}
export async function convergeTask(ws,taskId) {
  id(taskId);
  const readiness=await checkTask(ws,taskId);
  if(!readiness.ready) {
    const report={...readiness,status:'UNKNOWN',criteria:[],createdAt:new Date().toISOString()};
    // Missing/unsafe contracts must not cause the reader to create state elsewhere.
    const dir=await taskDir(ws,taskId);
    if(await exists(path.join(dir,'contract.json')))await atomicJSON(await contained(ws.state,path.join(dir,'convergence.json')),report);
    return report;
  }
  const t=await readyTask(ws,taskId),current=await context(ws,t);
  let records=[],evidenceError=null;
  try { records=await evidenceRecords(ws,t); }
  catch(error) { evidenceError=`Unreadable evidence: ${error.message}`; }
  records.sort((a,b)=>(Number(b.sequence)||0)-(Number(a.sequence)||0));
  const criteria=[];
  for(const criterion of t.contract.criteria) {
    const requirements=criterion.requires.flatMap(kind=>kind==='automated'
      ?t.contract.checks.filter(c=>c.criteria.includes(criterion.id)).map(c=>({kind,checkId:c.id})):[{kind}]);
    const evidence=[];
    for(const requirement of requirements) {
      const record=records.find(e=>e.kind===requirement.kind&&Array.isArray(e.criteria)&&e.criteria.includes(criterion.id)&&(!requirement.checkId||e.checkId===requirement.checkId));
      const reason=evidenceError??(record?await evidenceState(ws,t,record,current):'Missing evidence');
      evidence.push({...requirement,status:reason?'UNKNOWN':record.status,reason,
        file:record?.file??null,artifact:record?.artifact??null,attested:record?.attested===true,observer:record?.observer??null});
    }
    const status=evidence.some(e=>e.status==='FAIL')?'FAIL':evidence.some(e=>e.status==='UNKNOWN')?'UNKNOWN':'PASS';
    criteria.push({id:criterion.id,text:criterion.text,status,evidence});
  }
  const violations=await scopeViolations(t);
  // A concurrent edit while gathering evidence must not acquire the earlier verdict.
  const end=await context(ws,t);
  const stable=current.source.digest===end.source.digest&&current.configurationDigest===end.configurationDigest&&current.contractDigest===end.contractDigest;
  if(!stable)for(const criterion of criteria)criterion.status='UNKNOWN';
  const status=violations.length||criteria.some(c=>c.status==='FAIL')?'FAIL':!stable||criteria.some(c=>c.status==='UNKNOWN')?'UNKNOWN':'PASS';
  const report={taskId,ready:true,status,base:t.contract.base,current:current.source,configurationDigest:current.configurationDigest,
    contractDigest:current.contractDigest,scopeViolations:violations,criteria,stable,
    limitations:['Manual observations are attestations. Artifact hashes do not establish semantic correctness or review independence.','Only Git-tracked and non-ignored files belong to the source snapshot. Bind deployed artifacts separately for live claims.'],
    createdAt:new Date().toISOString()};
  await atomicJSON(await contained(ws.state,path.join(t.dir,'convergence.json')),report);
  return report;
}
