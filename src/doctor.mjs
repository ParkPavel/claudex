import path from 'node:path';
import { readJSON, ROOT, exists } from './io.mjs';
import { checkEntrypoints } from './workspace.mjs';
import { commandSpec, runCommand } from './process.mjs';
import { obsidianHealth } from './obsidian.mjs';
import { listJobs, TERMINAL } from './jobs.mjs';

export async function doctor(ws) {
  const checks = [];
  async function check(name,fn) {
    try { checks.push({name,status:'PASS',detail:await fn()}); }
    catch (e) { checks.push({name,status:'FAIL',detail:e.message}); }
  }
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
  return {ok:checks.every(c=>c.status==='PASS'),workspace:ws.root,project:ws.project,checks};
}
