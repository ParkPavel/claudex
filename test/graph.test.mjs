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

test('a path relative to the document\'s own folder resolves too',async t=>{
  const {project,graph}=await fixture(t);
  await fs.mkdir(path.join(project,'src','lib'),{recursive:true});
  await fs.writeFile(path.join(project,'src','README.md'),'The shared helper is lib/util.ts.\n');
  graph.nodes.push({id:'src_lib_util',label:'util.ts',source_file:'src/lib/util.ts',file_type:'code'});
  graph.nodes.push({id:'src_readme',label:'README',source_file:'src/README.md',file_type:'document'});
  const {graph:g,stats}=await linkDocs(project,graph);
  assert.ok(g.links.some(e=>e.source==='src_readme'&&e.target==='src_lib_util'&&e.confidence==='EXTRACTED'));
  assert.equal(stats.unverified.some(u=>u.path==='lib/util.ts'),false);
});

test('a shortened path resolves by unique suffix, as INFERRED, and an ambiguous one does not',async t=>{
  const {project,graph}=await fixture(t);
  await fs.writeFile(path.join(project,'docs','notes.md'),'See engine/aggregate.ts and settings/index.ts.\n');
  graph.nodes.push({id:'src_lib_engine_aggregate',label:'aggregate.ts',source_file:'src/lib/engine/aggregate.ts',file_type:'code'});
  graph.nodes.push({id:'a_settings',label:'index.ts',source_file:'src/a/settings/index.ts',file_type:'code'});
  graph.nodes.push({id:'b_settings',label:'index.ts',source_file:'src/b/settings/index.ts',file_type:'code'});
  graph.nodes.push({id:'docs_notes',label:'Notes',source_file:'docs/notes.md',file_type:'document'});
  const {graph:g,stats}=await linkDocs(project,graph);
  const e=g.links.find(x=>x.source==='docs_notes'&&x.target==='src_lib_engine_aggregate');
  assert.equal(e?.confidence,'INFERRED');
  assert.equal(e?.context,'path-suffix');
  assert.ok(stats.unverified.some(u=>u.path==='settings/index.ts'),'two candidates stay unverified');
});

test('a canonical GitHub blob URL links the document to the file it names',async t=>{
  const {project,graph}=await fixture(t);
  await fs.writeFile(path.join(project,'docs','urls.md'),[
    'See [src/view.ts](https://github.com/Owner/repo/blob/main/src/view.ts#L3) and',
    '[folder](https://github.com/Owner/repo/tree/main/src) and',
    '[gone](https://github.com/Owner/repo/blob/main/src/gone.ts).',
  ].join('\n'));
  graph.nodes.push({id:'docs_urls',label:'URLs',source_file:'docs/urls.md',file_type:'document'});
  const {graph:g,stats}=await linkDocs(project,graph,{githubRepo:'Owner/repo'});
  const e=g.links.filter(x=>x.source==='docs_urls');
  assert.deepEqual(e.map(x=>[x.target,x.confidence,x.context]),[['src_view','EXTRACTED','github-url']]);
  assert.ok(stats.unverified.some(u=>u.path==='src/gone.ts'),'a blob URL naming no file is unverified');
});

test('a blob URL links only for this repository, and trailing punctuation is not part of the path',async t=>{
  const {project,graph}=await fixture(t);
  await fs.writeFile(path.join(project,'docs','urls2.md'),[
    'Registered in https://github.com/Owner/repo/blob/main/src/view.ts.',
    'Unrelated: https://github.com/Someone/else/blob/main/src/view.ts',
  ].join('\n'));
  graph.nodes.push({id:'docs_urls2',label:'URLs2',source_file:'docs/urls2.md',file_type:'document'});
  const {graph:g}=await linkDocs(project,graph,{githubRepo:'owner/repo'});
  const e=g.links.filter(x=>x.source==='docs_urls2'&&x.context==='github-url');
  assert.deepEqual(e.map(x=>[x.target,x.source_location]),[['src_view','L1']]);
});

test('a tracked file Graphify withheld still gets a node when a document names it',async t=>{
  const {project,graph}=await fixture(t);
  await fs.mkdir(path.join(project,'src','ui'),{recursive:true});
  await fs.writeFile(path.join(project,'src','ui','tokens.css'),':root{}\n');
  git(project,'add','src/ui/tokens.css');
  await fs.writeFile(path.join(project,'docs','style.md'),'Tokens live in src/ui/tokens.css and not in src/ui/ghost.css.\n');
  graph.nodes.push({id:'docs_style',label:'Style',source_file:'docs/style.md',file_type:'document'});
  const {graph:g,stats}=await linkDocs(project,graph);
  const node=g.nodes.find(n=>n.source_file==='src/ui/tokens.css');
  assert.ok(node&&node.withheld===true,'a node is created for the tracked but withheld file');
  assert.ok(g.links.some(e=>e.source==='docs_style'&&e.target===node.id&&e.confidence==='EXTRACTED'&&e.context==='withheld-by-graphify'));
  assert.deepEqual(stats.unverified.filter(u=>u.doc==='docs/style.md').map(u=>u.path),['src/ui/ghost.css'],'an untracked path stays unverified');
});
