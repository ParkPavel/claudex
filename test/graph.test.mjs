import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { linkDocs, graphStatus, projectGraph, graphDir } from '../src/graph.mjs';
import { atomicJSON, snapshot } from '../src/io.mjs';

const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true});
// A repository and the Graphify graph for it, as graphify extract would leave it:
// AST nodes for code, one node per document, no document -> code edges.
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'claudex-graph-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,'project'),state=path.join(root,'.local','claudex');
  await fs.mkdir(path.join(project,'src'),{recursive:true});
  await fs.mkdir(path.join(project,'docs'),{recursive:true});
  await fs.mkdir(state,{recursive:true});
  git(project,'init','-b','main');
  git(project,'config','core.autocrlf','false');
  await fs.writeFile(path.join(project,'src','view.ts'),'export function getProjectViews() {}\nexport function main() {}\n');
  await fs.writeFile(path.join(project,'docs','architecture.md'),[
    '# Architecture',
    'Views are registered in `src/view.ts` by `getProjectViews()`.',
    'Pushes never go to `main`.',
    'The old loader lived in src/legacy/loader.ts.',
  ].join('\n'));
  git(project,'add','.');
  git(project,'-c','user.name=Graph test','-c','user.email=test@invalid','commit','-m','baseline');
  const graph={directed:false,multigraph:false,graph:{},nodes:[
    {id:'src_view',label:'view.ts',source_file:'src/view.ts',file_type:'code'},
    {id:'src_view_getprojectviews',label:'getProjectViews()',source_file:'src/view.ts',source_location:'L1',file_type:'code'},
    {id:'src_view_main',label:'main()',source_file:'src/view.ts',source_location:'L2',file_type:'code'},
    {id:'docs_architecture',label:'Architecture',source_file:'docs/architecture.md',file_type:'document'},
  ],links:[{source:'src_view',target:'src_view_getprojectviews',relation:'contains',confidence:'EXTRACTED'}]};
  const ws={root,project,state,config:{schemaVersion:2,project:'project',profile:'generic',access:'scoped',maxWorkers:2,models:{},assignments:{},executables:{},obsidian:{}}};
  return {ws,project,graph};
}
async function install(ws,project,graph) {
  const {graph:linked,stats}=await linkDocs(project,graph);
  await fs.mkdir(graphDir(ws),{recursive:true});
  await fs.writeFile(path.join(graphDir(ws),'graph.linked.json'),JSON.stringify(linked));
  await atomicJSON(path.join(graphDir(ws),'graph-state.json'),{schemaVersion:1,stable:true,snapshot:await snapshot(project),builtAt:'t',head:'h',counts:{},docCode:stats});
  return {linked,stats};
}

test('documents are linked to code by path and by unique symbol, with confidence',async t=>{
  const {project,graph}=await fixture(t);
  const {graph:g,stats}=await linkDocs(project,graph);
  const added=g.links.filter(e=>e._origin==='claudex-link-docs');
  assert.deepEqual(added.map(e=>[e.target,e.confidence,e.source_location]),[
    ['src_view','EXTRACTED','L2'],
    ['src_view_getprojectviews','INFERRED','L2'],
  ]);
  assert.equal(added.some(e=>e.target==='src_view_main'),false,'a plain word in backticks is prose, not a symbol');
  assert.deepEqual(stats.unverified,[{doc:'docs/architecture.md',line:4,path:'src/legacy/loader.ts'}]);
  assert.equal(graph.links.length,1,'the input graph is not mutated');
});

test('a graph built from another snapshot is STALE and is not projected',async t=>{
  const {ws,project,graph}=await fixture(t);
  await install(ws,project,graph);
  assert.equal((await graphStatus(ws)).status,'CURRENT');
  const current=await projectGraph(ws,project,['src/view.ts']);
  assert.equal(current.status,'CURRENT');
  await fs.writeFile(path.join(project,'src','view.ts'),'export function renamed() {}\n');
  assert.equal((await graphStatus(ws)).status,'STALE');
  const stale=await projectGraph(ws,project,['src/view.ts']);
  assert.equal(stale.status,'STALE');
  assert.doesNotMatch(stale.text,/getProjectViews/);
});

test('the projection shows the documents that describe the job\'s files',async t=>{
  const {ws,project,graph}=await fixture(t);
  await install(ws,project,graph);
  const p=await projectGraph(ws,project,['src']);
  assert.match(p.text,/\[EXTRACTED\] Architecture \(docs\/architecture\.md\) -documents-> view\.ts \(src\/view\.ts\)/);
  assert.match(p.text,/\[INFERRED\] Architecture .* -mentions-> getProjectViews\(\) \(src\/view\.ts:1\)/);
  assert.doesNotMatch(p.text,/-contains->/,'edges inside one file are left to the source itself');
  const outside=await projectGraph(ws,project,['docs/unrelated']);
  assert.equal(outside.edges,0);
});

test('a missing graph is reported, not invented',async t=>{
  const {ws,project}=await fixture(t);
  assert.equal((await graphStatus(ws)).status,'MISSING');
  assert.equal((await projectGraph(ws,project,['src'])).status,'MISSING');
});
