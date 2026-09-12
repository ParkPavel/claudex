#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, atomicJSON, readJSON, resolveWorkspace, ROOT, snapshot } from '../src/io.mjs';
import { initWorkspace, syncWorkspace, createWorktree } from '../src/workspace.mjs';
import { doctor } from '../src/doctor.mjs';
import { submit, runWorker, inspectJobs, cancel, jobFile, listJobs, TERMINAL } from '../src/jobs.mjs';
import { delegate, interactive, markUnavailable, panel, restore, settle, status as modeStatus } from '../src/modes.mjs';
import { scan, preCommit, prePush } from '../src/security.mjs';
import { obsidian } from '../src/obsidian.mjs';
import { runCommand } from '../src/process.mjs';

function args(input) {
  const out={_:[]};
  for(let i=0;i<input.length;i++) {
    const item=input[i];
    if(!item.startsWith('--'))out._.push(item);
    else { const name=item.slice(2); out[name]=input[i+1] && !input[i+1].startsWith('--') ? input[++i] : true; }
  }
  return out;
}
const options=args(process.argv.slice(2));
const command=options._[0] || 'help';
const print=value=>console.log(JSON.stringify(value,null,2));
try {
  if(command==='help') {
    console.log(`Claudex 0.1.0\n\ninit --workspace <desktop> --project <relative-folder> [--profile obsidian] [--vault <name>]\nsync | doctor                         Verify/update generated entrypoints\nworktree <task-id> [--base <ref>]      Prepare an isolated writer checkout\nrun <packet.json> [--wait]             Submit a versioned provider job\nstatus [job-id] | cancel <job-id>      Inspect/cancel the exact job\nobsidian <operation> [--params <json>] [--write]\nmodes [--status|--debt|--json]         Open the mode window; see who answers for whom\nmodes --delegate codex>claude --reason <text> [--roles a,b]\nmodes --unavailable <provider> --reason <text> | --restore <provider> [--note <text>]\nmodes --settle <delegation-id> --evidence <ref[,ref]>\ncheck-project                         Run the selected profile checks\nscan --repo <path> [--history]         Inspect staged content or all history\nguard commit|push                     Git hook entrypoints\n\nUse --workspace <desktop> from outside the workspace.\nState, evidence and credentials never belong in the public repository.`);
  } else if(command==='init') {
    assert(options.workspace && options.project,'init requires --workspace and --project');
    const ws=await initWorkspace(options);print({workspace:ws.root,project:ws.project,state:ws.state});
  } else if(command==='scan') {
    const result=await scan(path.resolve(options.repo || '.'),{history:options.history===true});print(result);if(!result.ok)process.exitCode=1;
  } else if(command==='guard') {
    const repo=path.resolve(options.repo || '.');
    if(options._[1]==='commit')await preCommit(repo);
    else if(options._[1]==='push') { let input='';for await(const chunk of process.stdin)input+=chunk;await prePush(repo,options.remote,options.url,input); }
    else throw new Error('Unknown guard');
  } else {
    const ws=await resolveWorkspace(options.workspace || process.cwd());
    if(command==='sync')print(await syncWorkspace(ws));
    else if(command==='doctor') {const result=await doctor(ws);print(result);if(!result.ok)process.exitCode=1;}
    else if(command==='worktree')print(await createWorktree(ws,options._[1],options.base));
    else if(command==='run') {
      const result=await submit(ws,await readJSON(path.resolve(options._[1])));print(result);
      if(options.wait) {
        while(true) { const job=await readJSON(jobFile(ws,result.jobId));if(TERMINAL.has(job.status)){print(job);if(job.status!=='COMPLETED')process.exitCode=1;break;}await new Promise(r=>setTimeout(r,500)); }
      }
    } else if(command==='worker')await runWorker(ws,options._[1]);
    else if(command==='status')print(await inspectJobs(ws,options._[1]));
    else if(command==='cancel')print(await cancel(ws,options._[1]));
    else if(command==='obsidian')print(await obsidian(ws,options._[1],options.params?JSON.parse(options.params):{},{write:options.write===true}));
    else if(command==='modes') {
      const report=async()=>modeStatus(ws,await listJobs(ws));
      if(options.delegate&&options.delegate!==true) {
        const [unavailable,substitute]=String(options.delegate).split('>').map(item=>item.trim());
        assert(unavailable&&substitute,'Use --delegate <unavailable>><substitute>, for example codex>claude');
        print(await delegate(ws,{unavailable,substitute,reason:options.reason===true?'':options.reason||'',roles:options.roles&&options.roles!==true?String(options.roles).split(',').map(r=>r.trim()).filter(Boolean):null}));
      } else if(options.unavailable&&options.unavailable!==true)print(await markUnavailable(ws,{provider:String(options.unavailable),reason:options.reason===true?'':options.reason||''}));
      else if(options.restore&&options.restore!==true)print(await restore(ws,{provider:String(options.restore),note:options.note&&options.note!==true?String(options.note):null}));
      else if(options.settle&&options.settle!==true)print(await settle(ws,{id:String(options.settle),evidence:options.evidence===true?'':options.evidence||''}));
      else if(options.debt===true)print((await report()).debt);
      else if(options.json===true||options.status===true)print(await report());
      // The window is interactive only where a person can answer it. Elsewhere the
      // same state prints once, so a script never blocks on a prompt.
      else if(process.stdin.isTTY&&process.stdout.isTTY) {
        const readline=await import('node:readline/promises');
        const rl=readline.createInterface({input:process.stdin,output:process.stdout});
        try{const session=await interactive(ws,{write:text=>process.stdout.write(text),question:prompt=>rl.question(prompt)},listJobs);print({acts:session.acts.length,state:await report()});}
        finally{rl.close();}
      } else console.log(panel(await report()));
    }
    else if(command==='check-project') {
      const profile=await readJSON(path.join(ROOT,'profiles',`${ws.config.profile}.json`));
      const before=await snapshot(ws.project);
      const results=[];
      const dir=path.join(ws.state,'artifacts',`checks-${Date.now()}`);await fs.mkdir(dir,{recursive:true});
      for(const [i,check] of profile.checks.entries()) {
        const resolvedArgs=check.args.map(arg=>arg.replaceAll('{artifactDirectory}',dir));
        try {const run=await runCommand(check.command,resolvedArgs,{cwd:ws.project,timeout:900000,maxBuffer:64*1024*1024});await fs.writeFile(path.join(dir,`${i}.log`),run.stdout+run.stderr);results.push({command:check,status:'PASS'});}
        catch(e){await fs.writeFile(path.join(dir,`${i}.log`),(e.stdout||'')+(e.stderr||''));results.push({command:check,status:'FAIL'});}
      }
      const after=await snapshot(ws.project);
      const result={before,after,results,freshness:before.digest===after.digest?'CURRENT':'STALE',acceptance:'UNKNOWN'};
      await atomicJSON(path.join(dir,'checks.json'),result);print({...result,artifactDirectory:dir});
      if(results.some(r=>r.status==='FAIL')||result.freshness==='STALE')process.exitCode=1;
    } else throw new Error(`Unknown command ${command}`);
  }
} catch(error) { console.error(`Claudex: ${error.message}`);process.exitCode=1; }
