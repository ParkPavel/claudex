import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { traceBuild, mergeTrace } from '../src/trace.mjs';

const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true});
// A project whose build script imports esbuild by default export and calls
// build() with options it owns -- the shape of an Obsidian plugin's
// esbuild.config.mjs. The stub records the options it was given and returns a
// metafile only when asked for one, as the real API does.
async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'claudex-trace-test-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,'project');
  await fs.mkdir(path.join(project,'node_modules','esbuild'),{recursive:true});
  await fs.mkdir(path.join(project,'src'),{recursive:true});
  git(project,'init','-b','main');
  git(project,'config','core.autocrlf','false');
  await fs.writeFile(path.join(project,'.gitignore'),'node_modules\n');
  await fs.writeFile(path.join(project,'node_modules','esbuild','package.json'),JSON.stringify({name:'esbuild',type:'module',exports:'./index.js'}));
  await fs.writeFile(path.join(project,'node_modules','esbuild','index.js'),[
    "import fs from 'node:fs';",
    "export default { async build(o) {",
    "  fs.writeFileSync(o.outfile, 'bundle');",
    "  return o.metafile ? { metafile: { inputs: {",
    "    'src/main.ts': { bytes: 10, imports: [{ path: 'src/App.svelte', kind: 'import-statement' }] },",
    "    'src/App.svelte': { bytes: 20, imports: [{ path: 'src/Button.svelte', kind: 'import-statement' }, { path: 'node_modules/lib/index.js', kind: 'import-statement' }] },",
    "    'src/Button.svelte': { bytes: 5, imports: [] },",
    "    'src/unused.ts': { bytes: 7, imports: [] },",
    "  }, outputs: { 'main.js': { inputs: { 'src/main.ts': { bytesInOutput: 9 }, 'src/App.svelte': { bytesInOutput: 18 }, 'src/Button.svelte': { bytesInOutput: 4 }, 'src/unused.ts': { bytesInOutput: 0 } } },",
    "    'main.css': { inputs: { 'src/App.svelte': { bytesInOutput: 3 } } } } } } : {};",
    "} };",
  ].join('\n'));
  await fs.writeFile(path.join(project,'build.mjs'),[
    "import esbuild from 'esbuild';",
    "if (process.argv[2] !== 'production') process.exit(3);",
    "await esbuild.build({ entryPoints: ['src/main.ts'], outfile: 'main.js', bundle: true });",
  ].join('\n'));
  await fs.writeFile(path.join(project,'main.js'),'tracked bundle\n');
  for (const f of ['main.ts','App.svelte','Button.svelte','unused.ts']) await fs.writeFile(path.join(project,'src',f),'// '+f+'\n');
  git(project,'add','.');
  git(project,'-c','user.name=Trace test','-c','user.email=test@invalid','commit','-m','baseline');
  return {project};
}

test('the real build script runs isolated and yields the bundler\'s own metafile',async t=>{
  const {project}=await fixture(t);
  const trace=await traceBuild(project,{script:'build.mjs',args:['production']});
  assert.deepEqual(Object.keys(trace.metafile.outputs).sort(),['main.css','main.js']);
  assert.equal(await fs.readFile(path.join(project,'main.js'),'utf8'),'tracked bundle\n','the checkout bundle is untouched');
  assert.equal(git(project,'status','--porcelain'),'','no file in the checkout changed');
});

test('build edges are merged into the graph, labelled, with what the AST pass missed counted',async t=>{
  const {project}=await fixture(t);
  const {metafile}=await traceBuild(project,{script:'build.mjs',args:['production']});
  const graph={nodes:[
    {id:'src_main',label:'main.ts',source_file:'src/main.ts'},
    {id:'src_app',label:'App.svelte',source_file:'src/App.svelte'},
    {id:'src_button',label:'Button.svelte',source_file:'src/Button.svelte'},
    {id:'src_unused',label:'unused.ts',source_file:'src/unused.ts'},
  ],links:[{source:'src_main',target:'src_app',relation:'imports_from',confidence:'EXTRACTED'}]};
  const {graph:g,stats}=mergeTrace(graph,metafile);
  const added=g.links.filter(e=>e._origin==='claudex-build-trace');
  assert.ok(added.some(e=>e.source==='src_app'&&e.target==='src_button'&&e.relation==='imports_from'&&e.confidence==='EXTRACTED'),'the svelte import the AST pass missed is added');
  assert.equal(added.filter(e=>e.source==='src_main'&&e.target==='src_app'&&e.relation==='imports_from').length,0,'an import the graph already has is not duplicated');
  assert.ok(added.some(e=>e.source==='src_app'&&e.target==='build_main_css'&&e.relation==='bundled_into'));
  assert.ok(!added.some(e=>e.source==='src_unused'&&e.relation==='bundled_into'),'a tree-shaken input is not bundled');
  assert.ok(g.nodes.some(n=>n.id==='build_main_js'&&n.file_type==='generated'));
  assert.deepEqual(stats.svelte,{inBuild:2,imports:1,alreadyInGraph:0,added:1});
  assert.deepEqual(stats.noBytes,['src/unused.ts']);
  assert.equal(graph.links.length,1,'the input graph is not mutated');
});
