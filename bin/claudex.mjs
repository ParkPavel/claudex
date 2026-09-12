#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, atomicJSON, readJSON, resolveWorkspace, ROOT, snapshot } from '../src/io.mjs';
import { initWorkspace, syncWorkspace, createWorktree } from '../src/workspace.mjs';
import { doctor } from '../src/doctor.mjs';
import { submit, runWorker, inspectJobs, cancel, jobFile, listJobs, TERMINAL } from '../src/jobs.mjs';
import { scan, preCommit, prePush } from '../src/security.mjs';
import { obsidian } from '../src/obsidian.mjs';
import { runCommand } from '../src/process.mjs';
import { delegate, interactive, markUnavailable, panel, parseDelegationSpec, restore, settle, status as modeStatus } from '../src/modes.mjs';
import { approve, pending } from '../src/approvals.mjs';
import { claim, readClaims, release, releaseFor } from '../src/claims.mjs';
import { inspectAll, retire } from '../src/worktrees.mjs';
import { runSetup } from '../src/setup.mjs';
import { validateConfig } from '../src/config.mjs';

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
const text=(value,fallback=null)=>(value===undefined||value===true?fallback:String(value));
const list=value=>(value&&value!==true?String(value).split(',').map(item=>item.trim()).filter(Boolean):null);
const version=(await readJSON(path.join(ROOT,'package.json'))).version;
// A window is only opened where a person can answer it; everywhere else the same
// state is printed once, so a script never blocks on a prompt.
const interactiveTerminal=()=>Boolean(process.stdin.isTTY&&process.stdout.isTTY);
async function terminalIO(fn) {
  const readline=await import('node:readline/promises');
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  try { return await fn({write:value=>process.stdout.write(value),question:prompt=>rl.question(prompt)}); }
  finally { rl.close(); }
}
try {
  if(command==='help') {
    console.log(`Claudex ${version}

setup [--workspace <desktop>]          Open the installation window and write the configuration
init --workspace <desktop> --project <folder> [--profile <name>] [--access full|scoped|approval] [--vault <name>]
settings [--access <mode>] [--assign <role>=<provider>[/<model>][@<effort>]] [--show]
sync | doctor                          Verify/update generated entrypoints and inspect the workspace
worktree <task-id> [--base <ref>] [--paths a,b]
worktree --retire <path> [--force --reason <text>] [--keep-branch]
claims [--release <id>]                Show or release declared work scopes
approve <task-id> --reason <text>      Issue a one-shot approval for one writing task
run <packet.json> [--wait]             Submit a versioned provider job
status [job-id] | cancel <job-id>      Inspect/cancel the exact job
obsidian <operation> [--params <json>] [--write]
modes [--status|--debt|--json]         Open the mode window; see who answers for whom
modes --delegate codex:claude --reason <text> [--roles a,b] [--model <id>]
modes --unavailable <provider> --reason <text> | --restore <provider> [--note <text>]
modes --settle <delegation-id> --evidence <ref[,ref]>
check-project                          Run the selected profile checks
scan --repo <path> [--history]         Inspect staged content or all history
guard commit|push                      Git hook entrypoints

Use --workspace <desktop> from outside the workspace.
State, evidence and credentials never belong in the public repository.`);
  } else if(command==='setup') {
    const root=path.resolve(text(options.workspace,process.cwd()));
    assert(interactiveTerminal(),'The setup window needs a terminal. Use init with explicit flags in a script.');
    const existing=await resolveWorkspace(root).catch(()=>null);
    const choices=await terminalIO(io=>runSetup(io,{root:existing?.root??root,config:existing?.config??null,project:text(options.project)}));
    if(!choices){console.log('Nothing written.');process.exitCode=1;}
    else if(existing) {
      const config={...existing.config,profile:choices.profile,access:choices.access,assignments:choices.assignments,models:choices.models,executables:choices.executables};
      validateConfig(config,await readJSON(path.join(ROOT,'config/roles.json')));
      await atomicJSON(path.join(existing.state,'workspace.json'),config);
      print(await syncWorkspace({...existing,config}));
    } else {
      const ws=await initWorkspace({workspace:root,project:choices.project,profile:choices.profile,access:choices.access,assignments:choices.assignments,models:choices.models,executables:choices.executables,vault:text(options.vault)});
      print({workspace:ws.root,project:ws.project,state:ws.state,access:ws.config.access});
    }
  } else if(command==='init') {
    assert(options.workspace && options.project,'init requires --workspace and --project');
    const ws=await initWorkspace({...options,access:text(options.access,'approval'),vault:text(options.vault)});
    print({workspace:ws.root,project:ws.project,state:ws.state,access:ws.config.access});
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
    else if(command==='settings') {
      const roles=await readJSON(path.join(ROOT,'config/roles.json'));
      if(options.show===true||(!options.access&&!options.assign))print({access:ws.config.access,models:ws.config.models,assignments:ws.config.assignments,storedVersion:ws.storedVersion});
      else {
        const config={...ws.config};
        if(options.access&&options.access!==true)config.access=String(options.access);
        for(const entry of (list(options.assign)??[])) {
          const [name,spec]=entry.split('=');
          assert(name&&spec,'Use --assign <role>=<provider>[/<model>][@<effort>]');
          const [providerAndModel,effort]=spec.split('@');
          const [provider,model]=providerAndModel.split('/');
          config.assignments={...config.assignments,[name]:{...(provider?{provider}:{}),...(model?{model}:{}),...(effort?{effort}:{})}};
        }
        validateConfig(config,roles);
        await atomicJSON(path.join(ws.state,'workspace.json'),config);
        print({access:config.access,assignments:config.assignments});
      }
    }
    else if(command==='worktree') {
      if(options.retire&&options.retire!==true) {
        const target=path.resolve(ws.root,String(options.retire));
        const result=await retire(ws.project,target,{force:options.force===true,reason:text(options.reason),removeBranch:options['keep-branch']!==true});
        // A retired checkout owns nothing; its scope goes back before the command returns.
        result.claimsReleased=(await releaseFor(ws,[target,result.branchDeleted])).released;
        print(result);
      } else if(options.list===true)print(await inspectAll(ws.project));
      else {
        // The scope is claimed before the checkout exists. A refused claim must
        // leave nothing behind: a half-created worktree and an orphan branch are
        // exactly the debris this command exists to prevent.
        const task=options._[1];
        const paths=list(options.paths);
        const reserved=paths?await claim(ws,{id:`claudex/${task}`,owner:'worktree',ref:`claudex/${task}`,paths,overlap:text(options.overlap)}):null;
        try {
          const created=await createWorktree(ws,task,options.base);
          if(reserved)created.claim=await claim(ws,{...reserved,ref:created.path,overlap:reserved.overlap});
          print(created);
        } catch (error) { if(reserved)await release(ws,reserved.id); throw error; }
      }
    }
    else if(command==='claims') {
      if(options.release&&options.release!==true)print(await release(ws,String(options.release)));
      else print(await readClaims(ws));
    }
    else if(command==='approve') {
      print(await approve(ws,{taskId:options._[1],reason:text(options.reason,'')}));
    }
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
        const {unavailable,substitute}=parseDelegationSpec(options.delegate);
        print(await delegate(ws,{unavailable,substitute,reason:text(options.reason,''),roles:list(options.roles),model:text(options.model)}));
      } else if(options.unavailable&&options.unavailable!==true)print(await markUnavailable(ws,{provider:String(options.unavailable),reason:text(options.reason,'')}));
      else if(options.restore&&options.restore!==true)print(await restore(ws,{provider:String(options.restore),note:text(options.note)}));
      else if(options.settle&&options.settle!==true)print(await settle(ws,{id:String(options.settle),evidence:text(options.evidence,'')}));
      else if(options.debt===true)print((await report()).debt);
      else if(options.json===true||options.status===true)print(await report());
      else if(interactiveTerminal()) {
        const session=await terminalIO(io=>interactive(ws,io,listJobs));
        print({acts:session.acts.length,state:await report()});
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
} catch (error) { console.error(`Claudex: ${error.message}`);process.exitCode=1; }
