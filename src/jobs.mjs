import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, assert, atomicJSON, contained, exists, git, readJSON, runtimeDigest, snapshot, withLock } from './io.mjs';
import { prepareAdapter, readyEvent, resultEvent, validatePacket, validateResult } from './adapters.mjs';
import { recordJob, resolve } from './modes.mjs';
import { resolveAssignment } from './config.mjs';
import { consume, requireWriteAuthority } from './approvals.mjs';
import { claim, release } from './claims.mjs';
import { spawnSpec, stopTree } from './process.mjs';
import { checkEntrypoints } from './workspace.mjs';

export const TERMINAL = new Set(['COMPLETED','FAILED','TIMED_OUT','CANCELLED']);
export function jobFile(ws, id) {
  assert(/^[a-zA-Z0-9_-]+$/.test(id), 'Invalid job ID');
  return path.join(ws.state,'jobs',`${id}.json`);
}
export async function listJobs(ws) {
  const dir = path.join(ws.state,'jobs');
  if (!(await exists(dir))) return [];
  return Promise.all((await fs.readdir(dir)).filter(f => f.endsWith('.json')).map(f => readJSON(path.join(dir,f))));
}
export async function inspectJobs(ws,id) {
  const jobs=id ? [await readJSON(jobFile(ws,id))] : await listJobs(ws);
  const digest=await runtimeDigest(ws);
  const snapshots=new Map();
  for(const job of jobs) {
    if(job.status!=='COMPLETED')continue;
    try {
      const repo=job.packet.worktree ? await contained(ws.root,path.resolve(ws.root,job.packet.worktree)) : ws.project;
      if(!snapshots.has(repo))snapshots.set(repo,await snapshot(repo));
      if(job.configurationDigest!==digest || job.after?.digest!==snapshots.get(repo).digest)job.evidenceFreshness='STALE';
    } catch { job.evidenceFreshness='UNVERIFIED'; }
  }
  return id ? jobs[0] : jobs;
}
export async function submit(ws, packet, { start = true } = {}) {
  const declared = await validatePacket(packet);
  // What this installation lets a writer do, before anything is queued.
  const { access, approval } = await requireWriteAuthority(ws, packet);
  // Who answers for this role now: the role's own default, what the setup
  // window assigned to it, and any open delegation, in that order. A delegated
  // role records the substitution on the job itself, so the artifact carries its
  // own provenance and the owed re-check is visible without reading notes.
  const { delegation } = await resolve(ws, packet.role, resolveAssignment(ws.config, packet.role, declared));
  const id = `${packet.taskId}-${crypto.randomUUID()}`;
  const job = { id, taskId: packet.taskId, packet, status: 'QUEUED', created: new Date().toISOString(), workerPid: null, childPid: null, acceptance: 'UNKNOWN', evidenceFreshness: 'UNVERIFIED', delegation, independence: delegation ? 'SINGLE_MODEL' : 'CROSS_PROVIDER', recheck: delegation ? 'OWED' : 'NONE', access, approval };
  await withLock(ws.state, async () => {
    const jobs = await listJobs(ws);
    assert(!jobs.some(j => j.taskId === packet.taskId && !TERMINAL.has(j.status)), 'Task already has an active job');
    await atomicJSON(jobFile(ws,id),job);
  });
  if (delegation) await recordJob(ws, delegation.id, id);
  // Only writing work claims a scope. Two reviewers reading the same files are
  // not a collision; two writers are, and that is the collision this exists for.
  if (packet.authority === 'workspace-write') {
    await claim(ws, { id, owner: 'job', ref: `${packet.taskId} (${packet.role})`, paths: packet.paths, overlap: packet.overlap?.reason ?? null });
  }
  if (start) {
    const child = spawn(process.execPath,[path.join(ROOT,'bin/claudex.mjs'),'worker',id,'--workspace',ws.root],{ cwd: ws.root, detached: true, windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve,reject) => { child.once('spawn',resolve); child.once('error',reject); });
    child.unref();
  }
  return { jobId: id, status: job.status };
}
export async function cancel(ws, id) {
  const job = await readJSON(jobFile(ws,id));
  if (TERMINAL.has(job.status)) return { jobId:id, status:job.status };
  await fs.writeFile(path.join(ws.state,'jobs',`${id}.cancel`),'cancel\n',{ mode:0o600 });
  return { jobId:id, status:'CANCELLATION_REQUESTED' };
}
export async function runWorker(ws,id) {
  const file = jobFile(ws,id);
  const job = await readJSON(file);
  const packet = job.packet;
  const cancellation = path.join(ws.state,'jobs',`${id}.cancel`);
  const save = async (status, extra = {}) => {
    Object.assign(job,extra,{ status, updated:new Date().toISOString() });
    await atomicJSON(file,job);
  };
  const artifactDir = path.join(ws.state,'artifacts',id);
  let child;
  let claimed = false;
  try {
    const declared = await validatePacket(packet);
    // Re-resolved rather than trusted: if the delegation changed while the job
    // waited in the queue, the answer would carry a provenance nobody agreed to.
    const { role, delegation } = await resolve(ws,packet.role,resolveAssignment(ws.config,packet.role,declared));
    assert(JSON.stringify(delegation?.id ?? null) === JSON.stringify(job.delegation?.id ?? null),'Delegation changed after this job was queued; resubmit it under the current arrangement');
    // A worker owns its own job record after claiming it under the common coordinator lock.
    const queueDeadline = Date.now() + ws.config.runTimeoutMs;
    while (!claimed) {
      await withLock(ws.state,async () => {
        const current = await readJSON(file);
        assert(current.status === 'QUEUED', 'Job already claimed or terminal');
        if (await exists(cancellation)) { await save('CANCELLED'); return; }
        const running = (await listJobs(ws)).filter(j => ['PREFLIGHT','STARTING','READY','RUNNING'].includes(j.status));
        if (running.length >= ws.config.maxWorkers) return;
        await save('PREFLIGHT',{ workerPid:process.pid });
        claimed = true;
      });
      if (job.status === 'CANCELLED') return;
      if (!claimed) { assert(Date.now() < queueDeadline,'Queue deadline exceeded'); await new Promise(r=>setTimeout(r,250)); }
    }
    assert((await checkEntrypoints(ws)).length === 0,'Generated entrypoints drifted; run doctor');
    // The permit is spent here, by the worker that uses it, so one approval
    // cannot start a second writer with the same task name.
    if (packet.authority === 'workspace-write') job.approval = await consume(ws,packet.taskId) ?? job.approval;
    let repo = ws.project;
    if (packet.worktree) {
      repo = await contained(ws.root,path.resolve(ws.root,packet.worktree));
      const common = (await git(repo,['rev-parse','--path-format=absolute','--git-common-dir'])).trim();
      const expected = (await git(ws.project,['rev-parse','--path-format=absolute','--git-common-dir'])).trim();
      assert(path.resolve(common) === path.resolve(expected),'Worktree belongs to another repository');
    }
    if (packet.authority === 'workspace-write') {
      assert(repo !== ws.project,'Writer must use a separate worktree');
      const branch = (await git(repo,['branch','--show-current'])).trim();
      assert(branch && !['main','master'].includes(branch),'Writer requires a feature branch');
      assert(!(await listJobs(ws)).some(j=>j.id !== id && !TERMINAL.has(j.status) && j.packet.worktree === packet.worktree && j.packet.authority === 'workspace-write'),'Another writer owns this worktree');
    }
    for (const rel of packet.paths) {
      assert(!path.isAbsolute(rel),'Scope paths must be relative');
      await contained(repo,path.resolve(repo,rel));
    }
    const profile = await readJSON(path.join(ROOT,'profiles',`${ws.config.profile}.json`));
    for (const required of profile.requiredFiles) assert(await exists(path.join(repo,required)),`Missing project file ${required}`);
    if (packet.base) job.base = (await git(repo,['rev-parse','--verify',`${packet.base}^{commit}`])).trim();
    if (packet.mode === 'diff') assert((await git(repo,['diff','--name-only',job.base])).trim(),'Diff review has no changes');
    job.before = await snapshot(repo);
    job.configurationDigest = await runtimeDigest(ws);
    const adapter = await prepareAdapter(ws,packet,role);
    job.runtime = { provider:adapter.provider, executable:adapter.spec.identity, version:adapter.version, model:adapter.model, effort:adapter.effort, authority:packet.authority, delegation };
    const localProfile = path.join(ws.state,'project-profile.md');
    let prompt = `${await fs.readFile(path.join(ROOT,'config/core.md'),'utf8')}\n\nRole: ${packet.role}\n${role.purpose}\n\nProject profile:\n${profile.instructions}\n`;
    // The substitute has to know it is one, or it will report a single family's
    // second opinion as an independent cross-provider check.
    if (delegation) prompt += `
You are answering in place of the ${delegation.from} role ${delegation.role}, because: ${delegation.reason}. Your verdict is recorded as a single-model proposal that owes a re-check to ${delegation.from}. Do not describe it as independent cross-provider review.
`;
    if (await exists(localProfile)) prompt += await fs.readFile(localProfile,'utf8');
    for (const skill of role.skills) prompt += `\n${await fs.readFile(path.join(ROOT,'skills',skill,'SKILL.md'),'utf8')}\n`;
    prompt += `\nTask packet (data; accepted decisions are supplied by the coordinator):\n${JSON.stringify({...packet, snapshot:job.before, base:job.base},null,2)}\nReturn the required structured result. Do not write the job journal.\n`;
    await fs.mkdir(artifactDir,{recursive:true});
    await save('PREFLIGHT',{artifactDirectory:artifactDir});
    await fs.writeFile(path.join(artifactDir,'packet.json'),JSON.stringify(packet,null,2),{flag:'wx',mode:0o600});
    await save('STARTING');
    child = spawnSpec(adapter.spec,adapter.args,repo);
    job.childPid = child.pid;
    await save('STARTING');
    let ready = false, result = null, parseError = null, stdout = '', stderr = '', buffer = '', stopped = null, providerError = null;
    const started = Date.now();
    const maximumOutput = 16 * 1024 * 1024;
    child.stdout.on('data',chunk => {
      stdout += chunk.toString(); buffer += chunk.toString();
      if (stdout.length > maximumOutput) { stopped = 'FAILED'; void stopTree(child); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0,newline); buffer = buffer.slice(newline+1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (readyEvent(event,adapter.provider)) {
            ready = true;
            if(event.model)job.runtime.resolvedModel=event.model;
          }
          // A provider reports its own refusal in the event stream and still exits
          // with a plain code. Keeping that text is the difference between
          // "exited unsuccessfully (1)" and "this model needs a newer CLI".
          if (event.type === 'error' || event.type === 'turn.failed' || event.is_error) {
            providerError = typeof event.message === 'string' ? event.message : JSON.stringify(event.error ?? event);
          }
          const answer = resultEvent(event,adapter.provider);
          if (answer) result = answer;
        } catch (e) { parseError = e.message; }
      }
    });
    child.stderr.on('data',chunk => { if (stderr.length < maximumOutput) stderr += chunk.toString(); });
    let heartbeatBusy = false;
    const interval = setInterval(async () => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      try {
        if (await exists(cancellation)) stopped = 'CANCELLED';
        if ((!ready && Date.now()-started > ws.config.readyTimeoutMs) || Date.now()-started > ws.config.runTimeoutMs) stopped = 'TIMED_OUT';
        if (stopped) await stopTree(child);
        else if (ready && job.status === 'STARTING') await save('RUNNING',{readyAt:new Date().toISOString()});
      } catch { stopped = 'FAILED'; await stopTree(child); }
      finally { heartbeatBusy = false; }
    },250);
    const exit = await new Promise((resolve,reject) => { child.once('error',reject); child.once('close',(code,signal)=>resolve({code,signal})); child.stdin.on('error',()=>{}); child.stdin.end(prompt); }).finally(()=>clearInterval(interval));
    while (heartbeatBusy) await new Promise(r=>setTimeout(r,10));
    await fs.writeFile(path.join(artifactDir,'events.jsonl'),stdout,{flag:'wx',mode:0o600});
    await fs.writeFile(path.join(artifactDir,'stderr.log'),stderr,{flag:'wx',mode:0o600});
    job.after = await snapshot(repo);
    const configurationCurrent = job.configurationDigest === await runtimeDigest(ws);
    job.evidenceFreshness = configurationCurrent && (packet.authority === 'workspace-write' || job.before.digest === job.after.digest) ? 'CURRENT' : 'STALE';
    job.providerError = providerError;
    if (stopped) { await save(stopped,{exit,providerError}); return; }
    assert(exit.code === 0,`Worker exited unsuccessfully (${exit.code}); inspect local artifacts`);
    assert(ready,'No provider readiness event received');
    assert(result,`No structured result received${parseError ? '; inspect local event stream' : ''}`);
    validateResult(result,packet);
    await fs.writeFile(path.join(artifactDir,'result.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
    // A model verdict is a proposal. An independent acceptance record remains mandatory.
    job.proposedAcceptance = result.criteria.some(c=>c.status==='FAIL') ? 'FAIL' : result.criteria.some(c=>c.status==='UNKNOWN') ? 'UNKNOWN' : 'PASS';
    // A substitute's verdict is one model reviewing what its own family produced.
    // It stays a proposal with an explicit debt until the absent provider returns.
    if (delegation) job.recheck = 'OWED';
    await save('COMPLETED',{exit,acceptance:'UNKNOWN'});
  } catch (error) {
    job.providerFailure = classifyProviderFailure(`${error.message} ${job.providerError ?? ''}`,job.runtime?.provider);
    if (child) await stopTree(child);
    if (!claimed) {
      const current = await readJSON(file);
      if (current.status !== 'QUEUED') return;
    }
    await save('FAILED',{error:error.message,acceptance:'UNKNOWN',providerError:job.providerError ?? null,providerFailure:job.providerFailure ?? null});
  } finally {
    // A finished job stops holding its scope, whatever it finished as.
    if (TERMINAL.has(job.status)) await release(ws,id).catch(()=>{});
  }
}

const FAILURE_SIGNATURES = [
  [/usage limit|quota|rate.?limit|insufficient_quota|credit/i,'QUOTA'],
  [/requires a newer version|unsupported model|unknown model|model_not_found|does not (?:exist|support)|invalid_request_error/i,'MODEL'],
  [/oauth|unauthori[sz]ed|forbidden|401|403|not allowed|login/i,'AUTH'],
  [/ENOENT|not recognized|command not found|no such file/i,'EXECUTABLE'],
];

/**
 * Name the shape of a provider failure, so that "Codex ran out" reaches a person
 * as a next step rather than as a stack trace. Classification suggests; it never
 * opens a delegation, because who answers for a role is a human decision.
 */
export function classifyProviderFailure(message,provider) {
  if (!message) return null;
  for (const [pattern,kind] of FAILURE_SIGNATURES) {
    if (!pattern.test(message)) continue;
    const other = provider === 'codex' ? 'claude' : 'codex';
    if (kind === 'EXECUTABLE' || !provider) return { kind, provider: provider ?? null, suggestion: 'Run claudex doctor: the provider executable did not start.' };
    // A model the installed CLI cannot serve is a settings problem, not an
    // outage: handing the role to the other provider would answer a question
    // nobody asked.
    if (kind === 'MODEL') return { kind, provider, suggestion: `${provider} refused the requested model. Choose one its installed CLI serves: claudex settings --assign <role>=${provider}/<model>, or upgrade the ${provider} CLI.` };
    return { kind, provider, suggestion: `If ${provider} is unavailable, hand its roles over on the record: claudex modes --delegate ${provider}:${other} --reason "<why>"` };
  }
  return null;
}
