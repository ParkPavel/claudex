import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, packet } from './helpers.mjs';
import { git, readJSON } from '../src/io.mjs';
import { createWorktree } from '../src/workspace.mjs';
import { blockers, inspect, inspectAll, linkTarget, listWorktrees, retire } from '../src/worktrees.mjs';
import { claim, conflictsWith, overlaps, readClaims, release, releaseFor } from '../src/claims.mjs';
import { classifyProviderFailure, submit, runWorker, jobFile, listJobs } from '../src/jobs.mjs';
import { approve } from '../src/approvals.mjs';
import { doctor } from '../src/doctor.mjs';
import { journal } from '../src/security.mjs';

const shared = async (ws, worktree) => {
  const target = path.join(worktree, 'node_modules');
  const source = path.join(ws.project, 'node_modules');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'marker.txt'), 'installed');
  await fs.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  return { source, target };
};

test('a worktree reports what would be lost by leaving it alone',async t=>{
 const ws=await fixture(t);
 const tree=await createWorktree(ws,'W1');
 const clean=await inspect(ws.project,(await listWorktrees(ws.project)).find(entry=>path.resolve(entry.path)===path.resolve(tree.path)));
 assert.equal(clean.dirty,0);assert.equal(clean.operation,null);assert.deepEqual(blockers(clean),[]);
 await fs.writeFile(path.join(tree.path,'source.txt'),'edited in the worktree');
 const dirty=await inspect(ws.project,(await listWorktrees(ws.project)).find(entry=>path.resolve(entry.path)===path.resolve(tree.path)));
 assert.equal(dirty.dirty,1);
 assert.match(blockers(dirty).join(),/uncommitted/);
});

test('an unfinished merge is a blocker, not a detail',async t=>{
 const ws=await fixture(t);
 const tree=await createWorktree(ws,'W2');
 await fs.writeFile(path.join(tree.path,`${path.sep}`.length?path.join(tree.path,'..','..','..','..','..','x')&&'source.txt':'source.txt'),'branch line\n');
 await git(tree.path,['add','.']);await git(tree.path,['commit','-m','branch change']);
 await fs.writeFile(path.join(ws.project,'source.txt'),'main line\n');
 await git(ws.project,['add','.']);await git(ws.project,['commit','-m','main change']);
 await git(tree.path,['merge','feature/test']).catch(()=>{});
 const report=await inspect(ws.project,(await listWorktrees(ws.project)).find(entry=>path.resolve(entry.path)===path.resolve(tree.path)));
 assert.equal(report.operation,'merge');
 assert.match(blockers(report).join(),/unfinished merge/);
});

test('retiring a worktree removes the link and never what it points at',async t=>{
 const ws=await fixture(t);
 const tree=await createWorktree(ws,'W3');
 const { source, target }=await shared(ws,tree.path);
 assert.ok(await linkTarget(target),'the fixture must actually create a link');
 const result=await retire(ws.project,tree.path);
 assert.deepEqual(result.unlinked,['node_modules']);
 // The whole point: the shared installation is still there afterwards.
 assert.equal(await fs.readFile(path.join(source,'marker.txt'),'utf8'),'installed');
 assert.equal((await listWorktrees(ws.project)).some(entry=>path.resolve(entry.path)===path.resolve(tree.path)),false);
});

test('retiring refuses unfinished work until someone says why',async t=>{
 const ws=await fixture(t);
 const tree=await createWorktree(ws,'W4');
 await fs.writeFile(path.join(tree.path,'source.txt'),'unsaved work');
 await assert.rejects(retire(ws.project,tree.path),/Refusing to retire/);
 await assert.rejects(retire(ws.project,tree.path,{force:true}),/needs a recorded reason/);
 const forced=await retire(ws.project,tree.path,{force:true,reason:'Superseded by the branch that already landed'});
 assert.equal(forced.forced,true);assert.match(forced.blockers.join(),/uncommitted/);
});

test('a scope is claimed once and conflicts are named, not discovered later',async t=>{
 const ws=await fixture(t);
 assert.equal(overlaps('docs','docs/api.md'),true);
 assert.equal(overlaps('docs/api.md','docs/user-guide.md'),false);
 await claim(ws,{id:'one',owner:'worktree',ref:'tree-one',paths:['docs','README.md']});
 const state=await readClaims(ws);
 assert.equal(conflictsWith(state,['docs/api.md']).length,1);
 await assert.rejects(claim(ws,{id:'two',owner:'worktree',ref:'tree-two',paths:['docs/api.md']}),/already claimed/);
 const intended=await claim(ws,{id:'two',owner:'worktree',ref:'tree-two',paths:['docs/api.md'],overlap:'Two languages of the same page, split deliberately'});
 assert.match(intended.overlap,/deliberately/);
 await release(ws,'one');
 assert.equal((await readClaims(ws)).claims.length,1);
});

test('writers claim their scope; readers do not',async t=>{
 const ws=await fixture(t);
 const tree=await createWorktree(ws,'W5');
 const worktree=path.relative(ws.root,tree.path);
 await approve(ws,{taskId:'W5',reason:'The plan and the scope were reviewed together'});
 await submit(ws,packet({taskId:'W5',role:'implementer',authority:'workspace-write',worktree,paths:['source.txt']}),{start:false});
 assert.equal((await readClaims(ws)).claims.length,1);
 // Two reviewers reading the same file are not a collision.
 await submit(ws,packet({taskId:'R1',paths:['source.txt']}),{start:false});
 await submit(ws,packet({taskId:'R2',paths:['source.txt']}),{start:false});
 assert.equal((await readClaims(ws)).claims.length,1);
});

test('a second writer over the same files is refused without a recorded reason',async t=>{
 const ws=await fixture(t);
 const first=await createWorktree(ws,'W6');
 const second=await createWorktree(ws,'W7');
 for(const id of ['W6','W7'])await approve(ws,{taskId:id,reason:'Reviewed the plan before the writer runs'});
 await submit(ws,packet({taskId:'W6',role:'implementer',authority:'workspace-write',worktree:path.relative(ws.root,first.path),paths:['source.txt']}),{start:false});
 await assert.rejects(
  submit(ws,packet({taskId:'W7',role:'implementer',authority:'workspace-write',worktree:path.relative(ws.root,second.path),paths:['source.txt']}),{start:false}),
  /already claimed/);
});

test('a provider failure is named as a next step',async()=>{
 assert.equal(classifyProviderFailure('Worker exited unsuccessfully (1)','codex'),null);
 const quota=classifyProviderFailure("You've hit your usage limit",'codex');
 assert.equal(quota.kind,'QUOTA');
 assert.match(quota.suggestion,/modes --delegate codex:claude/);
 assert.equal(classifyProviderFailure('403 oauth_org_not_allowed','claude').kind,'AUTH');
 assert.equal(classifyProviderFailure('spawn codex ENOENT','codex').kind,'EXECUTABLE');
 // A model the installed CLI cannot serve is a settings problem, not an outage:
 // suggesting a handover here would answer a question nobody asked.
 const model=classifyProviderFailure("The 'gpt-6-astra' model requires a newer version of Codex.",'codex');
 assert.equal(model.kind,'MODEL');
 assert.match(model.suggestion,/settings --assign/);
 assert.ok(!/delegate/.test(model.suggestion));
});

test('every push leaves a trace written by the guard, not by its author',async t=>{
 const ws=await fixture(t);
 const file=await journal(ws.project,{remote:'origin',url:'https://example.invalid/x.git',refs:[{localRef:'refs/heads/feature/test',localSha:'a'.repeat(40),remoteRef:'refs/heads/feature/test',remoteSha:'0'.repeat(40)}]});
 assert.ok(file);
 const written=(await fs.readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(written.length,1);
 assert.equal(written[0].remote,'origin');
 assert.equal(written[0].refs[0].localRef,'refs/heads/feature/test');
 assert.ok(Date.parse(written[0].at));
});

test('doctor sees the worktree that would otherwise be invisible',async t=>{
 const ws=await fixture(t);
 const healthy=await doctor(ws);
 const worktrees=healthy.checks.find(check=>check.name==='worktrees');
 assert.equal(worktrees.status,'PASS');
 const tree=await createWorktree(ws,'W8');
 await fs.writeFile(path.join(tree.path,'source.txt'),'work nobody committed');
 const report=await doctor(ws);
 const found=report.checks.find(check=>check.name==='worktrees');
 assert.equal(found.status,'FAIL');
 assert.match(found.detail,/uncommitted/);
 assert.equal(report.ok,false);
 assert.equal(report.access,'approval');
});

test('doctor reports a claim whose owner is gone',async t=>{
 const ws=await fixture(t);
 await claim(ws,{id:'ghost',owner:'job',ref:'ghost-task',paths:['source.txt']});
 const report=await doctor(ws);
 const claims=report.checks.find(check=>check.name==='scope-claims');
 assert.equal(claims.status,'FAIL');
 assert.match(claims.detail,/outlived their owner/);
 await release(ws,'ghost');
 assert.equal((await doctor(ws)).checks.find(check=>check.name==='scope-claims').status,'PASS');
 assert.equal((await listJobs(ws)).length,0);
});

test('a claim can be refined under the same id, and a refused one leaves nothing',async t=>{
 const ws=await fixture(t);
 // A worktree reserves its scope by branch name, then records the path it got.
 await claim(ws,{id:'claudex/T',owner:'worktree',ref:'claudex/T',paths:['src']});
 const refined=await claim(ws,{id:'claudex/T',owner:'worktree',ref:'/tmp/T',paths:['src']});
 assert.equal(refined.ref,'/tmp/T');
 assert.equal((await readClaims(ws)).claims.length,1);
 await assert.rejects(claim(ws,{id:'claudex/U',owner:'worktree',ref:'claudex/U',paths:['src/index.mjs']}),/already claimed/);
 assert.equal((await readClaims(ws)).claims.length,1,'a refused claim is not stored');
});

test('a retired worktree stops owning its scope',async t=>{
 const ws=await fixture(t);
 const tree=await createWorktree(ws,'W9');
 await claim(ws,{id:tree.branch,owner:'worktree',ref:tree.path,paths:['source.txt']});
 const result=await retire(ws.project,tree.path);
 const { released }=await releaseFor(ws,[tree.path,result.branchDeleted]);
 assert.equal(released,1);
 assert.deepEqual((await readClaims(ws)).claims,[]);
});

test('a worktree whose commits live in another branch is not holding them hostage',async t=>{
 const ws=await fixture(t);
 const tree=await createWorktree(ws,'W10');
 await fs.writeFile(path.join(tree.path,'source.txt'),'work committed on the worktree branch\n');
 await git(tree.path,['add','.']);await git(tree.path,['commit','-m','worktree commit']);
 const entry=(await listWorktrees(ws.project)).find(item=>path.resolve(item.path)===path.resolve(tree.path));
 const alone=await inspect(ws.project,entry,{mainBranch:'feature/test'});
 assert.equal(alone.ahead,1);assert.equal(alone.merged,false);
 assert.match(blockers(alone).join(),/held by no other branch/);
 // The same commit, now also on another branch: nothing is lost by retiring.
 await git(ws.project,['branch','keeps-the-work',(await git(tree.path,['rev-parse','HEAD'])).trim()]);
 const shared=await inspect(ws.project,entry,{mainBranch:'feature/test'});
 assert.ok(shared.heldElsewhere.some(ref=>ref.endsWith('keeps-the-work')));
 assert.deepEqual(blockers(shared),[]);
});

test('a provider that refuses in its event stream is heard, not just its exit code',async t=>{
 const ws=await fixture(t);
 const { jobId }=await submit(ws,packet({taskId:'PE1',goal:'provider-error'}),{start:false});
 await runWorker(ws,jobId);
 const job=await readJSON(jobFile(ws,jobId));
 assert.equal(job.status,'FAILED');
 // Without the event stream this reads "exited unsuccessfully (1)" and says nothing.
 assert.match(job.providerError,/requires a newer version/);
 assert.equal(job.providerFailure.kind,'MODEL');
 assert.match(job.providerFailure.suggestion,/settings --assign/);
});
