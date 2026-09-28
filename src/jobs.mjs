import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, assert, atomicJSON, contained, exists, git, readJSON, runtimeDigest, snapshot, withLock } from './io.mjs';
import { prepareAdapter, providerErrorText, readyEvent, resultEvent, validatePacket, validateResult } from './adapters.mjs';
import { recordJob, resolve } from './modes.mjs';
import { resolveAssignment } from './config.mjs';
import { consume, requireWriteAuthority } from './approvals.mjs';
import { claim, release } from './claims.mjs';
import { spawnSpec, stopTree } from './process.mjs';
import { checkEntrypoints } from './workspace.mjs';
import { checkEvidenceFor, validateTaskPacket } from './tasks.mjs';
import { projectGraph } from './graph.mjs';
import { previousReview, reviewContext, toolSteps } from './review.mjs';

export const TERMINAL = new Set(['COMPLETED','FAILED','TIMED_OUT','CANCELLED']);
export const STOP_RETRY_MS = 5000;
export const STOP_GRACE_MS = 30000;
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
  const taskContract = await validateTaskPacket(ws,packet);
  // A re-check that names a job it cannot answer is refused before it queues.
  if (packet.recheckOf) await previousReview(ws,packet,jobFile);
  // What this installation lets a writer do, before anything is queued.
  const { access, approval } = await requireWriteAuthority(ws, packet);
  // Who answers for this role now: the role's own default, what the setup
  // window assigned to it, and any open delegation, in that order. A delegated
  // role records the substitution on the job itself, so the artifact carries its
  // own provenance and the owed re-check is visible without reading notes.
  const { delegation } = await resolve(ws, packet.role, resolveAssignment(ws.config, packet.role, declared));
  const id = `${packet.taskId}-${crypto.randomUUID()}`;
  const job = { id, taskId: packet.taskId, packet, status: 'QUEUED', created: new Date().toISOString(), workerPid: null, childPid: null, acceptance: 'UNKNOWN', evidenceFreshness: 'UNVERIFIED', delegation, independence: delegation ? 'SINGLE_MODEL' : 'CROSS_PROVIDER', recheck: delegation ? 'OWED' : 'NONE', access, approval };
  if(taskContract)job.taskContract={id:taskContract.id,digest:taskContract.digest};
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
export function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid,0); return true; } catch (error) { return error.code === 'EPERM'; }
}
/**
 * A cancellation file is read by the worker, so a job whose worker died with
 * its session would stay RUNNING forever and was once closed by editing its
 * JSON by hand. When the worker is gone and its provider child is gone too, the
 * record is closed here. A surviving child is named and left alone: nothing
 * replaces a worker whose process is not confirmed terminated.
 */
// A liveness check by PID cannot tell a reused PID from the original process;
// it errs towards "alive", which leaves a job open rather than closing a live one.
export const ORPHAN_GRACE_MS = 60000;
const orphaned = job => (!job.workerPid && Date.now() - Date.parse(job.created ?? 0) > ORPHAN_GRACE_MS) || (job.workerPid && !processAlive(job.workerPid));
/**
 * `confirmEnded` is a person's statement, with what they checked, that the
 * stopped provider's whole process tree is gone. The harness can see only the
 * direct child; a detached helper can outlive it, so the direct PID being gone
 * is necessary but never sufficient, and the scope is released only on record.
 */
export async function cancel(ws, id, { confirmEnded = null } = {}) {
  const file = jobFile(ws,id);
  const job = await readJSON(file);
  if (TERMINAL.has(job.status)) {
    if (job.termination?.confirmed !== false) return { jobId:id, status:job.status };
    assert(!processAlive(job.termination.pid),`Provider process ${job.termination.pid} of ${id} still runs; end it, then cancel again`);
    assert(typeof confirmEnded === 'string' && confirmEnded.trim(),`Process ${job.termination.pid} is gone, but processes it started may not be. Check for them, then record it: claudex cancel ${id} --confirm-ended --reason "<what you checked>"`);
    // Released first: a failed release leaves the job unconfirmed, so cancel can be retried.
    await release(ws,id);
    await withLock(ws.state, async () => {
      const current = await readJSON(file);
      current.termination = { ...current.termination, confirmed:true, confirmedAt:new Date().toISOString(), confirmedBy:'person', reason:confirmEnded.trim() };
      await atomicJSON(file,current);
    });
    return { jobId:id, status:job.status, terminationConfirmed:true };
  }
  // Decided again under the lock: a worker may record its PID or claim its
  // slot between a read outside the lock and the write.
  const closed = await withLock(ws.state, async () => {
    const current = await readJSON(file);
    if (TERMINAL.has(current.status)) return { jobId:id, status:current.status };
    if (!orphaned(current)) return null;
    assert(!processAlive(current.childPid),`Worker ${current.workerPid} is gone but provider process ${current.childPid} still runs; end it, then cancel again`);
    const error = current.workerPid
      ? `orphaned: worker ${current.workerPid}${current.childPid ? ` and child ${current.childPid}` : ''} ended without closing the job`
      : 'orphaned: no worker ever started for this job';
    Object.assign(current,{ status:'CANCELLED', error, acceptance:'UNKNOWN', updated:new Date().toISOString() });
    await atomicJSON(file,current);
    return { jobId:id, status:'CANCELLED', orphaned:true, error };
  });
  // The job turned terminal between the first read and the lock; a request to
  // confirm its termination is answered by the terminal path, not dropped.
  if (closed && !closed.orphaned && confirmEnded) return cancel(ws,id,{ confirmEnded });
  if (closed) {
    // Outside the lock: release takes the same, non-reentrant lock. A failure
    // here leaves a stale claim that doctor reports and `claims --release` clears.
    if (closed.orphaned) await release(ws,id).catch(()=>{});
    return closed;
  }
  await fs.writeFile(path.join(ws.state,'jobs',`${id}.cancel`),'cancel\n',{ mode:0o600 });
  return { jobId:id, status:'CANCELLATION_REQUESTED' };
}

/**
 * Wait for jobs to reach a terminal state and return what a coordinator needs
 * to act on: status, per-criterion verdicts, findings, gaps and the postmortem.
 * Polling a file is the only signal a detached worker leaves; a caller that runs
 * this in the background is woken by its exit instead of polling by hand.
 */
export async function waitForJobs(ws, ids, { timeoutMs = 40*60000, intervalMs = 5000 } = {}) {
  ids = ids.length ? [...new Set(ids)] : (await listJobs(ws)).filter(j => !TERMINAL.has(j.status)).map(j => j.id);
  const deadline = Date.now() + timeoutMs;
  const done = new Map();
  while (done.size < ids.length) {
    for (const id of ids) {
      if (done.has(id)) continue;
      const job = await readJSON(jobFile(ws,id));
      if (TERMINAL.has(job.status)) done.set(id, await verdict(job));
    }
    if (done.size === ids.length || Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  const pending = ids.filter(id => !done.has(id));
  return { jobs:[...done.values()], pending, timedOut:pending.length > 0 };
}
async function verdict(job) {
  let result = null;
  if (job.artifactDirectory) result = await readJSON(path.join(job.artifactDirectory,'result.json')).catch(()=>null);
  return {
    id:job.id, taskId:job.taskId, status:job.status, proposedAcceptance:job.proposedAcceptance ?? null,
    model:job.runtime?.model ?? job.requested?.model ?? null,
    criteria:result?.criteria?.map(c => ({ id:c.id, status:c.status })) ?? null,
    findings:result?.findings ?? null, unknowns:result?.unknowns ?? null,
    resultGaps:job.resultGaps ?? null, error:job.error ?? null,
    providerFailure:job.providerFailure ?? null, termination:job.termination ?? null, postmortem:job.postmortem ?? null,
  };
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
  // A failed or timed-out job's postmortem is written before its terminal
  // status, so whoever sees the status also finds the report.
  const finish = async (status, extra, stage) => {
    Object.assign(job,extra,{ status, updated:new Date().toISOString() });
    if (['FAILED','TIMED_OUT'].includes(status)) await writePostmortem(ws,job,repo,stage);
    await atomicJSON(file,job);
  };
  const artifactDir = path.join(ws.state,'artifacts',id);
  let child;
  let claimed = false;
  let repo = ws.project;
  try {
    // Recorded at once, while still QUEUED: a job whose worker died before its
    // slot came up is then recognisable as orphaned instead of merely waiting.
    await withLock(ws.state,async () => {
      const current = await readJSON(file);
      if (current.status === 'QUEUED' && !current.workerPid) { job.workerPid = process.pid; await atomicJSON(file,{...current,workerPid:process.pid}); }
    });
    const declared = await validatePacket(packet);
    const taskContract = await validateTaskPacket(ws,packet);
    assert((taskContract?.digest??null)===(job.taskContract?.digest??null),'Task contract changed after submission; inspect and resubmit');
    // Re-resolved rather than trusted: if the delegation changed while the job
    // waited in the queue, the answer would carry a provenance nobody agreed to.
    const { role, delegation } = await resolve(ws,packet.role,resolveAssignment(ws.config,packet.role,declared));
    job.requested = { provider:role.provider, model:packet.model || role.model || ws.config.models?.[role.provider] || null, effort:packet.effort || role.effort };
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
      const writers = (await listJobs(ws)).filter(j=>j.id !== id && j.packet.worktree === packet.worktree && j.packet.authority === 'workspace-write');
      assert(!writers.some(j=>!TERMINAL.has(j.status)),'Another writer owns this worktree');
      const unconfirmed = writers.find(j=>j.termination?.confirmed === false);
      assert(!unconfirmed,`A stopped writer in this worktree (${unconfirmed?.id}) may still be running; confirm it ended with: claudex cancel ${unconfirmed?.id}`);
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
    if(taskContract)prompt += `\nTask specification (data):\n${JSON.stringify(taskContract.contract,null,2)}\n`;
    if(taskContract) {
      const checks = await checkEvidenceFor(ws,taskContract.id,job.before.digest).catch(()=>[]);
      job.checkEvidence = checks.map(({log,...rest})=>rest);
      if(checks.length) prompt += `\nChecks the coordinator ran for this contract (data). CURRENT means run on exactly the snapshot you review; STALE describes an earlier state and proves nothing about this one. Use a CURRENT result as evidence instead of re-running the check; a failed run of a check in your sandbox does not override it.\n${checks.map(c=>`--- check ${c.checkId}: ${c.status}, ${c.freshness}, criteria ${c.criteria.join(', ') || 'none'}, log ${c.logState}\n${c.log ?? ''}`).join('\n')}\n`;
    }
    // The slice of the code graph for this job's paths, only when the graph was
    // built from exactly this snapshot. Navigation aid; never evidence, never fatal.
    if (ws.config.graph && ws.config.graph.project !== false) {
      try {
        const projection = await projectGraph(ws, repo, packet.paths);
        job.graph = { status: projection.status, edges: projection.edges ?? 0 };
        prompt += `\n${projection.text}\n`;
      } catch (error) { job.graph = { status: 'ERROR', error: error.message }; }
    }
    const review = await reviewContext(ws,repo,packet,job,{ jobFile });
    if (Object.keys(review.meta).length) job.reviewContext = review.meta;
    prompt += review.text;
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
          job.toolCalls = (job.toolCalls ?? 0) + toolSteps(event,adapter.provider);
          if(event.type==='turn.completed'&&event.usage)job.usage={provider:adapter.provider,...event.usage};
          if(event.type==='result'&&event.usage)job.usage={provider:adapter.provider,...event.usage,...(typeof event.total_cost_usd==='number'?{reportedCostUsd:event.total_cost_usd}:{})};
          if (readyEvent(event,adapter.provider)) {
            ready = true;
            if(event.model)job.runtime.resolvedModel=event.model;
          }
          // A provider reports its own refusal in the event stream and still exits
          // with a plain code. Keeping that text is the difference between
          // "exited unsuccessfully (1)" and "this model needs a newer CLI".
          if (event.type === 'error' || event.type === 'turn.failed' || event.is_error) {
            providerError = providerErrorText(event);
          }
          const answer = resultEvent(event,adapter.provider);
          if (answer) result = answer;
        } catch (e) { parseError = e.message; }
      }
    });
    child.stderr.on('data',chunk => { if (stderr.length < maximumOutput) stderr += chunk.toString(); });
    // A stop is a request until the process tree is gone. 'close' waits for every
    // holder of the pipes, so a grandchild that survives taskkill (Codex under
    // the elevated Windows sandbox) once kept a timed-out job RUNNING for hours.
    // The kill is repeated, and after STOP_GRACE_MS the worker stops waiting and
    // records that termination was not confirmed instead of hanging.
    let heartbeatBusy = false, settleExit = null, stopRequestedAt = null, lastKill = 0, lastKillOk = null;
    const interval = setInterval(async () => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      try {
        if (!stopped && await exists(cancellation)) stopped = 'CANCELLED';
        if (!stopped && ((!ready && Date.now()-started > ws.config.readyTimeoutMs) || Date.now()-started > ws.config.runTimeoutMs)) stopped = 'TIMED_OUT';
        if (stopped) {
          stopRequestedAt ??= Date.now();
          if (Date.now()-lastKill >= STOP_RETRY_MS) { lastKill = Date.now(); lastKillOk = await stopTree(child); }
          if (Date.now()-stopRequestedAt > STOP_GRACE_MS) {
            child.stdout.destroy(); child.stderr.destroy();
            settleExit?.({ code:null, signal:null, unconfirmed:true });
          }
        }
        else if (ready && job.status === 'STARTING') await save('RUNNING',{readyAt:new Date().toISOString()});
      } catch { stopped ??= 'FAILED'; await stopTree(child); }
      finally { heartbeatBusy = false; }
    },250);
    const exit = await new Promise((resolve,reject) => { settleExit = resolve; child.once('error',reject); child.once('close',(code,signal)=>resolve({code,signal})); child.stdin.on('error',()=>{}); child.stdin.end(prompt); }).finally(()=>clearInterval(interval));
    // The direct child closing is not the tree ending: a kill that failed may
    // have left a detached helper behind, so both must hold to confirm.
    // Read the kill's outcome only after an in-flight kill has finished.
    while (heartbeatBusy) await new Promise(r=>setTimeout(r,10));
    if (stopRequestedAt) job.termination = { requestedAt:new Date(stopRequestedAt).toISOString(), confirmed:!exit.unconfirmed && lastKillOk !== false, pid:child.pid };
    await fs.writeFile(path.join(artifactDir,'events.jsonl'),stdout,{flag:'wx',mode:0o600});
    await fs.writeFile(path.join(artifactDir,'stderr.log'),stderr,{flag:'wx',mode:0o600});
    job.after = await snapshot(repo);
    const contractCurrent = !job.taskContract || (await validateTaskPacket(ws,packet)).digest===job.taskContract.digest;
    const configurationCurrent = job.configurationDigest === await runtimeDigest(ws) && contractCurrent;
    job.evidenceFreshness = configurationCurrent && (packet.authority === 'workspace-write' || job.before.digest === job.after.digest) ? 'CURRENT' : 'STALE';
    job.providerError = providerError;
    if (stopped) {
      await finish(stopped,{exit,providerError},job.status);
      return;
    }
    assert(exit.code === 0,`Worker exited unsuccessfully (${exit.code}); inspect local artifacts`);
    assert(ready,'No provider readiness event received');
    assert(result,`No structured result received${parseError ? '; inspect local event stream' : ''}`);
    const checked = validateResult(result,packet);
    result = checked.result;
    if (checked.gaps) job.resultGaps = checked.gaps;
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
    await finish('FAILED',{error:error.message,acceptance:'UNKNOWN',providerError:job.providerError ?? null,providerFailure:job.providerFailure ?? null},job.status);
  } finally {
    // A finished job stops holding its scope, whatever it finished as, unless
    // its provider may still be running: then the scope stays claimed until
    // cancel confirms the process ended, so no second writer joins it.
    if (TERMINAL.has(job.status) && job.termination?.confirmed !== false) await release(ws,id).catch(()=>{});
  }
}

/**
 * What a failed or timed-out job leaves for the next attempt: what the packet
 * promised, where it stopped, who was answering, what it left behind and what
 * to look at before trying again. Pure: the caller supplies the leftovers.
 * A cancellation is a person's decision, not a failure, and gets no report.
 */
const LEFTOVER_LIMIT = 200;
export function buildPostmortem(job,{changed=[],repo=null}={}) {
  if (!['FAILED','TIMED_OUT'].includes(job.status)) return null;
  const packet = job.packet ?? {};
  const stage = job.stage ?? null;
  const provider = job.runtime ? { provider:job.runtime.provider, model:job.runtime.resolvedModel ?? job.runtime.model, effort:job.runtime.effort, version:job.runtime.version ?? null }
    : job.requested ? { ...job.requested, version:null } : null;
  const started = !['QUEUED','PREFLIGHT'].includes(stage);
  // A stopped job (TIMED_OUT) never passes through the catch that classifies
  // provider errors; classify here too, or a lost connection that retried
  // until the deadline reads as "the packet was too big".
  const providerFailure = job.providerFailure ?? classifyProviderFailure(`${job.error ?? ''} ${job.providerError ?? ''}`.trim(), provider?.provider);
  const nextChecks = [];
  if (providerFailure?.suggestion) nextChecks.push(providerFailure.suggestion);
  if (!started) nextChecks.push('Failed before the provider started; resolve the error above before resubmitting.');
  else if (stage === 'STARTING') nextChecks.push('The provider never reported readiness: check the executable, authentication and connectivity with claudex doctor.');
  else if (job.status === 'TIMED_OUT' && providerFailure?.kind !== 'NETWORK') nextChecks.push('The run exceeded runTimeoutMs: narrow the packet, or raise the limit deliberately.');
  if (job.termination && !job.termination.confirmed) nextChecks.push(`Termination of provider process ${job.termination.pid} was not confirmed; make sure it has ended before resubmitting.`);
  if (started) nextChecks.push('Read events.jsonl and stderr.log in the artifact directory before retrying.');
  if (job.before && job.after && job.before.digest !== job.after.digest && packet.authority !== 'workspace-write') nextChecks.push('Source changed while a read-only job ran; its partial output describes no single snapshot.');
  if (changed.length) nextChecks.push(`Uncommitted changes remain in ${repo ?? 'the repository'} (${changed.length}): ${changed.slice(0,10).join(', ')}${changed.length>10?', ...':''}. Inspect, keep or retire them before retrying; a retry starts from this state.`);
  return {
    schemaVersion: 1,
    jobId: job.id ?? null,
    taskId: job.taskId ?? packet.taskId ?? null,
    status: job.status,
    promised: { role:packet.role ?? null, authority:packet.authority ?? null, mode:packet.mode ?? null, goal:packet.goal ?? null, paths:packet.paths ?? [], criteria:(packet.criteria ?? []).map(c=>c.id), contractId:packet.contractId ?? null, worktree:packet.worktree ?? null },
    failure: { stage, error:job.error ?? null, providerError:job.providerError ?? null, providerFailure, exit:job.exit ?? null },
    provider,
    delegation: job.delegation ?? null,
    usage: job.usage ?? null,
    // An untracked dependency tree must not turn a report into megabytes.
    leftovers: { repo, count:changed.length, changed:changed.slice(0,LEFTOVER_LIMIT), truncated:changed.length > LEFTOVER_LIMIT, before:job.before?.digest ?? null, after:job.after?.digest ?? null },
    nextChecks,
    createdAt: new Date().toISOString(),
  };
}

// Never lets reporting mask the failure it reports: any error here is swallowed.
async function writePostmortem(ws,job,repo,stage) {
  try {
    job.stage = stage;
    let changed = [];
    try {
      // In -z form a rename or copy is followed by its origin as a separate entry.
      const entries = (await git(repo,['status','--porcelain=v1','-z','--untracked-files=all'])).split('\0');
      for (let i = 0; i < entries.length; i++) {
        if (!entries[i]) continue;
        changed.push(entries[i].slice(3));
        // Either column may carry it: "R " is staged, " R" is a work-tree rename.
        if (/[RC]/.test(entries[i].slice(0,2))) i++;
      }
    } catch {}
    const report = buildPostmortem(job,{changed,repo:path.relative(ws.root,repo).split(path.sep).join('/') || '.'});
    if (!report) return;
    // Validates the ID before it names a directory, not after.
    const record = jobFile(ws,job.id);
    const dir = path.join(ws.state,'artifacts',job.id);
    await fs.mkdir(dir,{recursive:true});
    const file = path.join(dir,'postmortem.json');
    await fs.writeFile(file,JSON.stringify(report,null,2),{mode:0o600});
    job.postmortem = path.relative(ws.root,file).split(path.sep).join('/');
    await atomicJSON(record,job);
  } catch {}
}

const FAILURE_SIGNATURES = [
  // Codex reports a lost network as "waiting for network (Connection failed:
  // error sending request)" or "stream disconnected before completion".
  [/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|can't reach|DNS|os error 1100[14]|waiting for network|connection failed: error sending request|stream disconnected before completion/i,'NETWORK'],
  // Codex says "usage limit"; Claude says "session limit" or "weekly limit".
  [/usage limit|session limit|weekly limit|hit your \w+ limit|quota|rate.?limit|insufficient_quota|credit/i,'QUOTA'],
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
    if(kind==='NETWORK')return {kind,provider:provider??null,suggestion:'Provider connection failed before completion. Check connectivity; preserve work and do not retry or substitute providers automatically.'};
    if (kind === 'EXECUTABLE' || !provider) return { kind, provider: provider ?? null, suggestion: 'Run claudex doctor: the provider executable did not start.' };
    // A model the installed CLI cannot serve is a settings problem, not an
    // outage: handing the role to the other provider would answer a question
    // nobody asked.
    if (kind === 'MODEL') return { kind, provider, suggestion: `${provider} refused the requested model. Choose one its installed CLI serves: claudex settings --assign <role>=${provider}/<model>, or upgrade the ${provider} CLI.` };
    return { kind, provider, suggestion: `If ${provider} is unavailable, hand its roles over on the record: claudex modes --delegate ${provider}:${other} --reason "<why>"` };
  }
  return null;
}
