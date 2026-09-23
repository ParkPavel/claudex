import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { exists } from './io.mjs';
import { runCommand } from './process.mjs';
import { withIsolatedCopy } from './isolate.mjs';

// The bundler knows exactly which sources became which generated files; a
// parser only guesses. traceBuild runs the project's own build script, in an
// isolated copy of the snapshot, and records esbuild's metafile. The script is
// not edited: a loader hook hands its `import esbuild` a shim that calls the
// real build with metafile: true. (esbuild's CJS exports are getters, so the
// module object itself cannot be patched.)

const HOOK = `
let shim;
export async function initialize(data) { shim = data.shim; }
export async function resolve(specifier, context, next) {
  if (specifier === 'esbuild' && context.parentURL !== shim) return { url: shim, shortCircuit: true };
  return next(specifier, context);
}
`;
const PRELOAD = hook => `
import { register } from 'node:module';
register(${JSON.stringify(hook)}, { data: { shim: ${JSON.stringify('SHIM_URL')} } });
`;
const SHIM = `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(process.env.CLAUDEX_TRACE_REAL).href);
const real = mod.default ?? mod;
const traced = { ...real, async build(options) {
  const result = await real.build({ ...options, metafile: true });
  fs.writeFileSync(process.env.CLAUDEX_TRACE_OUT, JSON.stringify(result.metafile ?? null));
  return result;
} };
export default traced;
`;

export async function traceBuild(repo, { script, args = [], timeoutMs = 900000 }) {
  return withIsolatedCopy(repo, async dir => {
    const work = path.join(dir, '.claudex-trace');
    await fs.mkdir(work, { recursive: true });
    const hook = path.join(work, 'hook.mjs'), shim = path.join(work, 'shim.mjs'), preload = path.join(work, 'preload.mjs');
    const out = path.join(work, 'metafile.json');
    await fs.writeFile(hook, HOOK);
    await fs.writeFile(shim, SHIM);
    await fs.writeFile(preload, PRELOAD(pathToFileURL(hook).href).replace('"SHIM_URL"', JSON.stringify(pathToFileURL(shim).href)));
    const real = createRequire(path.join(dir, 'package.json')).resolve('esbuild');
    const run = await runCommand(process.execPath, ['--import', pathToFileURL(preload).href, script, ...args], {
      cwd: dir, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CLAUDEX_TRACE_OUT: out, CLAUDEX_TRACE_REAL: real },
    });
    const metafile = (await exists(out)) ? JSON.parse(await fs.readFile(out, 'utf8')) : null;
    if (!metafile) throw new Error('The build ran but never called esbuild.build with the traced module');
    return { metafile, log: run.stdout + run.stderr };
  });
}

const IMPORTS = new Set(['imports', 'imports_from', 're_exports', 'dynamic_import']);
const norm = p => p.replaceAll('\\', '/').replace(/^\.\//, '');
// esbuild reports a dependency reached through the node_modules link by its real
// path (../../<checkout>/node_modules/...); both forms are outside the project.
const external = p => /(^|\/)node_modules\//.test(p) || p.startsWith('../');
const outputId = p => `build_${norm(p).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;

/**
 * Add what the bundler observed to a graph: import edges the AST pass missed,
 * source -> generated-file edges (bundled_into, with bytes) and optional
 * post-build merges (mergedInto: {"main.css": "styles.css"}). All EXTRACTED:
 * they are the build's own record. Pure; the input graph is not mutated.
 */
export function mergeTrace(graph, metafile, { mergedInto = {} } = {}) {
  const g = { ...graph, nodes: [...graph.nodes], links: [...graph.links] };
  const fileNode = new Map();
  for (const n of g.nodes) {
    if (!n.source_file) continue;
    const f = norm(n.source_file), cur = fileNode.get(f);
    if (!cur || (!n.source_location && cur.source_location)) fileNode.set(f, n);
  }
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const have = new Set();
  for (const e of g.links) {
    if (!IMPORTS.has(e.relation)) continue;
    const a = byId.get(e.source), b = byId.get(e.target);
    if (a?.source_file && b?.source_file) have.add(`${norm(a.source_file)}>${norm(b.source_file)}`);
  }
  const add = e => g.links.push({ ...e, confidence: 'EXTRACTED', confidence_score: 1, _origin: 'claudex-build-trace' });
  const stats = { svelte: { inBuild: 0, imports: 0, alreadyInGraph: 0, added: 0 }, imports: { total: 0, alreadyInGraph: 0, added: 0 }, bundled: 0, noBytes: [], external: 0, unknownInputs: [] };
  for (const [input, info] of Object.entries(metafile.inputs ?? {})) {
    const from = fileNode.get(norm(input));
    if (!from) { if (external(norm(input))) stats.external++; else stats.unknownInputs.push(norm(input)); continue; }
    const svelte = /\.svelte$/.test(input);
    if (svelte) stats.svelte.inBuild++;
    for (const imp of info.imports ?? []) {
      const to = fileNode.get(norm(imp.path ?? ''));
      if (!to || to === from) continue;
      const key = `${norm(input)}>${norm(imp.path)}`;
      const bucket = [stats.imports, ...(svelte ? [stats.svelte] : [])];
      bucket.forEach(s => (s === stats.imports ? s.total++ : s.imports++));
      if (have.has(key)) { bucket.forEach(s => s.alreadyInGraph++); continue; }
      have.add(key);
      bucket.forEach(s => s.added++);
      add({ source: from.id, target: to.id, relation: 'imports_from', context: imp.kind ?? 'import', source_file: norm(input) });
    }
  }
  const emitted = new Map();
  for (const [output, info] of Object.entries(metafile.outputs ?? {})) {
    const id = outputId(output);
    emitted.set(norm(output), id);
    if (!byId.has(id)) { const n = { id, label: norm(output), source_file: norm(output), file_type: 'generated', _origin: 'claudex-build-trace' }; g.nodes.push(n); byId.set(id, n); }
    for (const [input, part] of Object.entries(info.inputs ?? {})) {
      const from = fileNode.get(norm(input));
      if (!from || !(part.bytesInOutput > 0)) continue;
      add({ source: from.id, target: id, relation: 'bundled_into', bytes: part.bytesInOutput, source_file: norm(input) });
      stats.bundled++;
    }
  }
  const outputBytes = new Map();
  for (const info of Object.values(metafile.outputs ?? {})) for (const [input, part] of Object.entries(info.inputs ?? {})) outputBytes.set(norm(input), (outputBytes.get(norm(input)) ?? 0) + (part.bytesInOutput ?? 0));
  // Inputs that contributed no bytes: re-export barrels and type-only modules as
  // often as dead code. A list to inspect, not a verdict.
  stats.noBytes = [...outputBytes].filter(([f, b]) => b === 0 && fileNode.has(f)).map(([f]) => f).sort();
  for (const [from, to] of Object.entries(mergedInto)) {
    const src = emitted.get(norm(from));
    const dst = fileNode.get(norm(to));
    if (src && dst) add({ source: src, target: dst.id, relation: 'merged_into', source_file: norm(from) });
  }
  return { graph: g, stats };
}
