import path from 'node:path';
import { readJSON, ROOT, exists } from './io.mjs';
import { checkEntrypoints } from './workspace.mjs';
import { commandSpec, runCommand } from './process.mjs';
import { obsidianHealth } from './obsidian.mjs';
import { listJobs, TERMINAL } from './jobs.mjs';
import { CONFIG_VERSION, resolveAssignment } from './config.mjs';
import { blockers, inspectAll } from './worktrees.mjs';
import { readClaims, normalise, stale } from './claims.mjs';
import { debtFromJobs, mode, readDelegation } from './modes.mjs';
import { pending } from './approvals.mjs';

export async function doctor(ws) {
  const checks = [];
  async function check(name,fn) {
    try { checks.push({name,status:'PASS',detail:await fn()}); }
    catch (e) { checks.push({name,status:'FAIL',detail:e.message}); }
  }
  await check('configuration',async()=> {
    const roles=await readJSON(path.join(ROOT,'config/roles.json'));
    const assignments=Object.keys(ws.config.assignments ?? {}).map(name=>{
      const resolved=resolveAssignment(ws.config,name,roles[name]);
      return `${name} → ${resolved.provider}${resolved.model?`/${resolved.model}`:''}`;
    });
    if(ws.migrated)throw new Error(`Configuration on disk is version ${ws.storedVersion}; this harness reads version ${CONFIG_VERSION}. Run sync to write the upgrade down.`);
    return {access:ws.config.access,assignments:assignments.length?assignments:'role defaults'};
  });
  await check('generated-entrypoints',async()=> { const drift=await checkEntrypoints(ws); if(drift.length)throw new Error(drift.join(', ')); return 'Hashes match'; });
  await check('project-profile',async()=> {
    const profile=await readJSON(path.join(ROOT,'profiles',`${ws.config.profile}.json`));
    for(const file of profile.requiredFiles)if(!(await exists(path.join(ws.project,file))))throw new Error(`Missing ${file}`);
    return profile.name;
  });
  for(const provider of ['claude','codex']) await check(provider,async()=> {
    const spec=await commandSpec(ws.config.executables[provider]);
    const version=(await runCommand(ws.config.executables[provider],['--version'])).stdout.trim();
    return {executable:spec.identity,version,model:ws.config.models[provider] || (provider==='claude'?'role-defined':null)};
  });
  if(ws.config.profile==='obsidian')await check('obsidian-cli',()=>obsidianHealth(ws));
  // Worktrees are where work is lost: an unfinished merge and an uncommitted
  // rewrite once sat in two of them while this command reported a healthy
  // workspace, because it had never looked.
  await check('worktrees',async()=> {
    const reports=await inspectAll(ws.project);
    if(!reports.length)return 'No worker checkouts';
    const unsafe=reports.filter(report=>blockers(report).length);
    const summary=reports.map(report=>({
      path:path.relative(ws.root,report.path),
      branch:report.branch,
      dirty:report.dirty ?? null,
      operation:report.operation ?? null,
      ahead:report.ahead ?? null,
      behind:report.behind ?? null,
      retirable:report.merged === true && !blockers(report).length,
      sharedInstall:report.sharedInstall ?? null,
    }));
    if(unsafe.length)throw new Error(unsafe.map(report=>`${path.relative(ws.root,report.path)}: ${blockers(report).join('; ')}`).join(' | '));
    return summary;
  });
  await check('scope-claims',async()=> {
    const state=await readClaims(ws);
    if(!state.claims.length)return 'No open claims';
    const jobs=await listJobs(ws);
    const live=new Set(jobs.filter(job=>!TERMINAL.has(job.status)).map(job=>job.id));
    const paths=new Set((await inspectAll(ws.project)).map(report=>normalise(report.path)));
    const orphaned=stale(state,{liveJobs:live,livePaths:paths});
    if(orphaned.length)throw new Error(`Claims outlived their owner; release them: ${orphaned.map(entry=>entry.ref).join(', ')}`);
    return state.claims.map(entry=>`${entry.ref}: ${entry.paths.join(', ')}${entry.overlap?' (overlap recorded)':''}`);
  });
  await check('delegation',async()=> {
    const state=await readDelegation(ws);
    const debt=debtFromJobs(state,await listJobs(ws));
    const owed=debt.reduce((total,item)=>total+item.jobs.length,0);
    if(owed)throw new Error(`${owed} job(s) answered by a substitute still owe a re-check: claudex modes --debt`);
    return {mode:mode(state),open:state.open.map(entry=>`${entry.unavailable} → ${entry.substitute}`)};
  });
  await check('approvals',async()=> {
    const permits=await pending(ws);
    const expired=permits.filter(permit=>permit.expired);
    if(expired.length)throw new Error(`Expired approvals remain; remove or reissue: ${expired.map(permit=>permit.taskId).join(', ')}`);
    return permits.length?permits.map(permit=>permit.taskId):'None outstanding';
  });
  await check('orphan-jobs',async()=> {
    const orphan=[];
    for(const job of await listJobs(ws)) {
      if(TERMINAL.has(job.status))continue;
      if(!job.workerPid) { if(Date.now()-Date.parse(job.created)>60000)orphan.push(job.id); continue; }
      try { process.kill(job.workerPid,0); } catch { orphan.push(job.id); }
    }
    if(orphan.length)throw new Error(`Inspect orphan jobs before recovery: ${orphan.join(', ')}`);
    return 'No orphan processes detected';
  });
  return {ok:checks.every(c=>c.status==='PASS'),workspace:ws.root,project:ws.project,access:ws.config.access,checks};
}
