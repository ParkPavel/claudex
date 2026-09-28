import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectProfile, mergePrinciples, principlesSection, readPrinciples, runSetup, suggestedChecks } from '../src/setup.mjs';

const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true});
async function workspace(t,{manifest=true}={}) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'claudex-setup-test-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,'plugin');
  await fs.mkdir(project);
  git(project,'init','-b','main');
  await fs.writeFile(path.join(project,'package.json'),JSON.stringify({scripts:{build:'x',test:'x',lint:'x',dev:'x'}}));
  if(manifest)await fs.writeFile(path.join(project,'manifest.json'),JSON.stringify({id:'p',minAppVersion:'1.5.0'}));
  return {root,project};
}
// Answers in order; an empty answer takes the default the window offers.
function scripted(answers) {
  const asked=[],out=[];
  // Running out of answers fails the test instead of re-asking forever.
  return {asked,out,io:{write:text=>out.push(text),question:async prompt=>{asked.push(prompt);if(!answers.length)throw new Error(`Script ran out of answers at: ${prompt}`);return answers.shift();}}};
}
const probe=async()=>[{name:'node',found:true,version:'v22.0.0',problem:null},{name:'codex',found:false,version:null,problem:'not installed or not on PATH'}];

test('the window shows the environment first, offers the detected profile and suggested checks, and records principles and hooks',async t=>{
  const {root}=await workspace(t);
  // project, profile (accept obsidian? no: generic keeps the test free of vault questions), access, 2×2 provider answers, skip roles, principles ×4, hooks, confirm
  const {io,asked,out}=scripted(['plugin','generic','scoped','','','','','skip','русский','','',''  ,'no','yes']);
  const choices=await runSetup(io,{root,probe});
  assert.match(out[0],/Environment[\s\S]*codex +— +! not installed/);
  assert.ok(asked.some(prompt=>prompt.startsWith('profile [obsidian]')),asked.join('\n'));
  assert.ok(asked.some(prompt=>prompt.includes('[npm run build, npm test, npm run lint]')),asked.join('\n'));
  assert.deepEqual(choices.principles,{language:'русский',branch:'main',merge:'person',checks:'npm run build, npm test, npm run lint'});
  assert.equal(choices.hooks,false);
  assert.equal(choices.profile,'generic');
  assert.match(out.at(-1),/principles русский · branch main · merge by person/);
});

test('rerunning the window offers the principles already recorded',async t=>{
  const {root}=await workspace(t,{manifest:false});
  const profileText=`# Local notes\n\n${principlesSection({language:'русский',branch:'trunk',merge:'agent',checks:'npm test'})}\n`;
  const config={project:'plugin',profile:'generic',access:'scoped',assignments:{},models:{},executables:{}};
  const {io,asked}=scripted(['','','','','','','skip','','','','','','']);
  const choices=await runSetup(io,{root,config,probe,profileText});
  assert.deepEqual(choices.principles,{language:'русский',branch:'trunk',merge:'agent',checks:'npm test'});
  assert.ok(asked.some(prompt=>prompt.startsWith('protected branch [trunk]')));
});

test('principles replace their own section and keep what the person wrote around it',()=>{
  const first=principlesSection({language:'English',branch:'main',merge:'person',checks:''},'2026-09-01');
  const text=mergePrinciples('# Profile\n\nHand-written invariant.\n',first);
  assert.match(text,/Hand-written invariant\.\n\n<!-- claudex:principles:start -->/);
  assert.match(text,/the project states none; ask before inventing one/);
  const second=mergePrinciples(`${text}\nAfter.\n`,principlesSection({language:'русский',branch:'main',merge:'agent',checks:'npm test'},'2026-09-28'));
  assert.equal(second.match(/claudex:principles:start/g).length,1);
  assert.match(second,/Hand-written invariant/);
  assert.match(second,/After\./);
  assert.equal(readPrinciples(second).merge,'agent');
  assert.equal(readPrinciples('no section'),null);
});

test('detection needs an Obsidian manifest, and only check-like scripts are suggested',async t=>{
  const {project}=await workspace(t);
  assert.equal(await detectProfile(project),'obsidian');
  assert.deepEqual(await suggestedChecks(project),['npm run build','npm test','npm run lint']);
  await fs.writeFile(path.join(project,'manifest.json'),JSON.stringify({name:'web-app'}));
  assert.equal(await detectProfile(project),'generic');
  assert.deepEqual(await suggestedChecks(path.join(project,'missing')),[]);
});
