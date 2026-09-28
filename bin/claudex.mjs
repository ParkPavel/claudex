#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, atomicJSON, readJSON, resolveWorkspace, ROOT, snapshot } from '../src/io.mjs';
import { initWorkspace, syncWorkspace, createWorktree } from '../src/workspace.mjs';
import { doctor } from '../src/doctor.mjs';
import { submit, runWorker, inspectJobs, cancel, listJobs, waitForJobs } from '../src/jobs.mjs';
import { scan, preCommit, prePush } from '../src/security.mjs';
import { obsidian } from '../src/obsidian.mjs';
import { runCommand } from '../src/process.mjs';
import { withIsolatedCopy } from '../src/isolate.mjs';
import { buildGraph, graphCommand, graphStatus, relinkGraph, traceGraph } from '../src/graph.mjs';
import { delegate, interactive, markUnavailable, panel, parseDelegationSpec, restore, settle, status as modeStatus } from '../src/modes.mjs';
import { approve, pending } from '../src/approvals.mjs';
import { claim, readClaims, release, releaseFor } from '../src/claims.mjs';
import { inspectAll, retire } from '../src/worktrees.mjs';
import { mergePrinciples, principlesSection, runSetup } from '../src/setup.mjs';
import { validateConfig } from '../src/config.mjs';
import { installHooks, runHook } from '../src/hooks.mjs';
import { retro } from '../src/retro.mjs';

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
init --workspace <desktop> --project <folder> [--profile <name>] [--access full|scoped|approval]
     [--vault <name> --vault-path <absolute-path> --test-vault --obsidian-executable <command>]
settings [--access <mode>] [--assign <role>=<provider>[/<model>][@<effort>]] [--show]
sync | doctor                          Verify/update generated entrypoints and inspect the workspace
worktree <task-id> [--base <ref>] [--paths a,b]
worktree --retire <path> [--force --reason <text>] [--keep-branch]
claims [--release <id>]                Show or release declared work scopes
approve <task-id> --reason <text>      Issue a one-shot approval for one writing task
run <packet.json> [--wait]             Submit a versioned provider job
status [job-id] | cancel <job-id>      Inspect/cancel the exact job; cancel closes a job whose worker died
wait [job-id ...] [--timeout-min <n>]  Block until the jobs (default: every active one) finish; exit 2 on timeout
status --summary                     Compact job states without packets/transcripts
task init <id> --goal <text> [--kind feature|bug|maintenance] [--worktree <path>]
task check <id>                       Validate the local contract before implementation
task verify <id> --check <check-id>   Run a declared check and bind evidence to source
task record <id> --params <json>      Record an explicit, snapshot-bound observation
task converge <id>                    Report PASS, FAIL or UNKNOWN for every criterion
obsidian <operation> [--params <json>] [--write]
modes [--status|--debt|--json]         Open the mode window; see who answers for whom
modes --delegate codex:claude --reason <text> [--roles a,b] [--model <id>]
modes --unavailable <provider> --reason <text> | --restore <provider> [--note <text>]
modes --settle <delegation-id> --evidence <ref[,ref]>
check-project                          Run the selected profile checks
retro [--since <date>]                 Journal retrospective: failure causes, models, costs, UNKNOWN share
graph build [--code-only] | graph relink | graph trace | graph status  Build the project's code graph (vendored Graphify) or check it is current
graph query|path|explain|affected|god-nodes <args>  Navigate the linked graph
hook <session-start|handoff|pre-run|report-ready>  Claude Code hook entrypoints (read the event on stdin; never block)
hooks --install                        Merge the Claudex hooks into .claude/settings.local.json
scan --repo <path> [--history]         Inspect staged content or all history
guard commit|push                      Git hook entrypoints

Use --workspace <desktop> from outside the workspace.
State, evidence and credentials never belong in the public repository.`);
  } else if(command==='setup') {
    const root=path.resolve(text(options.workspace,process.cwd()));
    assert(interactiveTerminal(),'The setup window needs a terminal. Use init with explicit flags in a script.');
    const existing=await resolveWorkspace(root).catch(()=>null);
    const profileText=existing?await fs.readFile(path.join(existing.state,'project-profile.md'),'utf8').catch(()=>null):null;
    const choices=await terminalIO(io=>runSetup(io,{root:existing?.root??root,config:existing?.config??null,project:text(options.project),profileText}));
    if(!choices){console.log('Nothing written.');process.exitCode=1;}
    else {
      let ws;
      if(existing) {
        const config={...existing.config,profile:choices.profile,access:choices.access,assignments:choices.assignments,models:choices.models,executables:choices.executables,...(choices.obsidian?{obsidian:choices.obsidian}:{})};
        validateConfig(config,await readJSON(path.join(ROOT,'config/roles.json')));
        await atomicJSON(path.join(existing.state,'workspace.json'),config);
        ws={...existing,config};
        await syncWorkspace(ws);
      } else ws=await initWorkspace({workspace:root,project:choices.project,profile:choices.profile,access:choices.access,assignments:choices.assignments,models:choices.models,executables:choices.executables,obsidian:choices.obsidian,vault:text(options.vault)});
      const profileFile=path.join(ws.state,'project-profile.md');
      await fs.writeFile(profileFile,mergePrinciples(await fs.readFile(profileFile,'utf8').catch(()=>''),principlesSection(choices.principles)));
      const hooks=choices.hooks?await installHooks(ws):null;
      // The installation is finished when doctor says so, not when the files exist.
      const health=await doctor(ws);
      print({workspace:ws.root,project:ws.project,access:ws.config.access,principles:profileFile,hooks:hooks?.file??null,
        doctor:health.checks.map(c=>`${c.status} ${c.name}${c.status==='FAIL'?`: ${typeof c.detail==='string'?c.detail:JSON.stringify(c.detail)}`:''}`)});
      if(!health.ok)process.exitCode=1;
    }
  } else if(command==='init') {
    assert(options.workspace && options.project,'init requires --workspace and --project');
    const obsidian={
      ...(text(options.vault)?{vault:text(options.vault)}:{}),
      ...(text(options['vault-path'])?{vaultPath:path.resolve(text(options['vault-path']))}:{}),
      ...(options['test-vault']===true?{testVault:true}:{}),
    };
    const executables=text(options['obsidian-executable'])?{obsidian:text(options['obsidian-executable'])}:{};
    const ws=await initWorkspace({...options,access:text(options.access,'approval'),obsidian,executables});
    print({workspace:ws.root,project:ws.project,state:ws.state,access:ws.config.access});
  } else if(command==='hook') {
    // A hook fails open: whatever goes wrong, the session, turn or tool call proceeds.
    try {
      let raw='';if(!process.stdin.isTTY)for await(const chunk of process.stdin)raw+=chunk;
      // The gate runs on every shell call; most never name Claudex.
      if(options._[1]==='pre-run'&&!raw.includes('claudex.mjs'))process.exit(0);
      let input={};try{input=JSON.parse(raw||'{}');}catch{}
      const ws=await resolveWorkspace(options.workspace || input.cwd || process.cwd());
      const output=await runHook(ws,options._[1],input);
      if(output)process.stdout.write(JSON.stringify(output));
    } catch {}
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
        const waited=await waitForJobs(ws,[result.jobId],{timeoutMs:Number.MAX_SAFE_INTEGER,intervalMs:500});
        print(waited.jobs[0]);if(waited.jobs[0].status!=='COMPLETED')process.exitCode=1;
      }
    } else if(command==='worker')await runWorker(ws,options._[1]);
    else if(command==='status') {
      const result=await inspectJobs(ws,options._[1]);
      print(options.summary===true ? (Array.isArray(result)?result:[result]).map(job=>({
        id:job.id,taskId:job.taskId,status:job.status,acceptance:job.acceptance,
        evidenceFreshness:job.evidenceFreshness,updated:job.updated??job.created,
        provider:job.runtime?.provider??null,model:job.runtime?.model??null,
        usage:job.usage??null,
        error:job.error??null,
        postmortem:job.postmortem??null,
      })) : result);
    }
    else if(command==='task') {
      const tasks=await import('../src/tasks.mjs');
      const operation=options._[1],id=options._[2];
      let result;
      if(operation==='init')result=await tasks.initTask(ws,{taskId:id,goal:text(options.goal),kind:text(options.kind,'feature'),worktree:text(options.worktree)});
      else if(operation==='check') {
        result=await tasks.checkTask(ws,id);
        if(!result.ready)process.exitCode=1;
      } else if(operation==='verify') {
        assert(text(options.check),'task verify requires --check <check-id>');
        result=await tasks.verifyTask(ws,id,text(options.check));
        if(result.status!=='PASS'||result.freshness==='STALE')process.exitCode=1;
      } else if(operation==='record') {
        assert(text(options.params),'task record requires --params <json>');
        result=await tasks.recordTask(ws,id,JSON.parse(text(options.params)));
      } else if(operation==='converge') {
        result=await tasks.convergeTask(ws,id);
        if(result.status!=='PASS')process.exitCode=1;
      } else throw new Error('Use task init|check|verify|record|converge <id>');
      print(result);
    }
    else if(command==='cancel')print(await cancel(ws,options._[1]));
    else if(command==='retro')print(await retro(ws,{since:text(options.since)}));
    else if(command==='hooks') {
      assert(options.install===true,'Use hooks --install');
      print(await installHooks(ws));
    }
    else if(command==='wait') {
      const minutes=Number(text(options['timeout-min'],'40'));
      assert(minutes>0,'--timeout-min must be a positive number');
      const waited=await waitForJobs(ws,options._.slice(1),{timeoutMs:minutes*60000});
      print(waited);
      process.exitCode=waited.timedOut?2:waited.jobs.every(job=>job.status==='COMPLETED')?0:1;
    }
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
    else if(command==='graph') {
      const sub=options._[1];
      if(sub==='build')print(await buildGraph(ws,{codeOnly:options['code-only']===true}));
      else if(sub==='relink')print(await relinkGraph(ws));
      else if(sub==='trace')print(await traceGraph(ws));
      else if(sub==='status'||!sub){const st=await graphStatus(ws);print(st);if(st.status!=='CURRENT')process.exitCode=1;}
      else process.stdout.write(await graphCommand(ws,options._.slice(1)));
    }
    else if(command==='check-project') {
      const profile=await readJSON(path.join(ROOT,'profiles',`${ws.config.profile}.json`));
      const before=await snapshot(ws.project);
      const results=[];
      const dir=path.join(ws.state,'artifacts',`checks-${Date.now()}`);await fs.mkdir(dir,{recursive:true});
      for(const [i,check] of profile.checks.entries()) {
        const resolvedArgs=check.args.map(arg=>arg.replaceAll('{artifactDirectory}',dir));
        try {const exec=cwd=>runCommand(check.command,resolvedArgs,{cwd,timeout:900000,maxBuffer:64*1024*1024});const run=check.isolate?await withIsolatedCopy(ws.project,exec):await exec(ws.project);await fs.writeFile(path.join(dir,`${i}.log`),run.stdout+run.stderr);results.push({command:check,status:'PASS'});}
        catch(e){await fs.writeFile(path.join(dir,`${i}.log`),(e.stdout||'')+(e.stderr||''));results.push({command:check,status:'FAIL'});}
      }
      const after=await snapshot(ws.project);
      const result={before,after,results,freshness:before.digest===after.digest?'CURRENT':'STALE',acceptance:'UNKNOWN'};
      await atomicJSON(path.join(dir,'checks.json'),result);print({...result,artifactDirectory:dir});
      if(results.some(r=>r.status==='FAIL')||result.freshness==='STALE')process.exitCode=1;
    } else throw new Error(`Unknown command ${command}`);
  }
} catch (error) { console.error(`Claudex: ${error.message}`);process.exitCode=1; }
