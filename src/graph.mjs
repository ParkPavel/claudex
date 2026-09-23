import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, assert, atomicJSON, exists, git, readJSON, snapshot } from './io.mjs';

// Code graph for the managed project, built by the vendored Graphify
// (vendor/graphify, see vendor/graphify/UPSTREAM.md) and owned by Claudex:
// Claudex decides when it is built, whether it is current for a snapshot, and
// which slice a job sees. Graphify's own agent hooks are not installed; they
// would rewrite the entrypoints Claudex generates.
//
// PYTHONHASHSEED is set explicitly: without it Graphify re-executes itself
// through os.execvpe to pin the seed, and on Windows that re-exec through a uv
// venv launcher dies with an access violation (0xC0000005) and no output.

const DEFAULT_EXCLUDES = ['node_modules', '.git', 'releases', '*.map', 'images', 'coverage', 'package-lock.json', 'data.json'];
const CODE = /\.(ts|tsx|svelte|mjs|cjs|js|jsx|py|ps1|css)$/i;
const DOC = /\.md$/i;

export function graphDir(ws) { return path.join(ws.state, 'graph'); }
const graphFile = ws => path.join(graphDir(ws), 'graphify-out', 'graph.json');
const linkedFile = ws => path.join(graphDir(ws), 'graph.linked.json');
const stateFile = ws => path.join(graphDir(ws), 'graph-state.json');

function run(command, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(out) : reject(Object.assign(new Error(`graphify exited ${code}`), { output: out })));
  });
}

/**
 * Build the graph for ws.project. Code is parsed locally (tree-sitter); unless
 * codeOnly, documents go to the configured LLM backend. The run starts in a
 * neutral directory so a CLI backend does not load this workspace's hooks or
 * instructions into every extraction call.
 */
export async function buildGraph(ws, { codeOnly = false } = {}) {
  const cfg = ws.config.graph ?? {};
  assert(cfg.python, 'Set graph.python in local workspace.json to a Python with Graphify\'s dependencies');
  const out = graphDir(ws);
  await fs.mkdir(out, { recursive: true });
  const neutral = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-graph-'));
  const excludes = [...DEFAULT_EXCLUDES, ...(cfg.excludes ?? [])].flatMap(e => ['--exclude', e]);
  const args = ['-m', 'graphify', 'extract', ws.project, '--out', out, '--no-gitignore', ...excludes,
    ...(codeOnly ? ['--code-only'] : ['--backend', cfg.backend ?? 'claude-cli'])];
  const env = { ...process.env, PYTHONPATH: [path.join(ROOT, 'vendor'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    PYTHONIOENCODING: 'utf-8', PYTHONHASHSEED: '0', ...(cfg.model ? { GRAPHIFY_CLAUDE_CLI_MODEL: cfg.model } : {}) };
  const before = await snapshot(ws.project);
  let log;
  try { log = await run(cfg.python, args, { cwd: neutral, env }); }
  catch (error) {
    // A silent native crash is otherwise indistinguishable from success.
    await fs.writeFile(path.join(out, 'build.log'), error.output ?? '');
    throw new Error(`${error.message}; see ${path.join(out, 'build.log')}`);
  }
  finally { await fs.rm(neutral, { recursive: true, force: true }).catch(() => {}); }
  const graph = await readJSON(graphFile(ws));
  const linked = await linkDocs(ws.project, graph);
  await fs.writeFile(linkedFile(ws), JSON.stringify(linked.graph));
  const after = await snapshot(ws.project);
  const state = {
    schemaVersion: 1, builtAt: new Date().toISOString(), codeOnly,
    head: (await git(ws.project, ['rev-parse', 'HEAD'])).trim(),
    snapshot: before, stable: before.digest === after.digest,
    counts: countGraph(linked.graph), docCode: linked.stats, graphify: graphifyVersion(log),
  };
  await atomicJSON(stateFile(ws), state);
  await fs.writeFile(path.join(out, 'build.log'), log ?? '');
  return state;
}

function graphifyVersion(log) {
  return /graphify\s+(\d+\.\d+\.\d+)/i.exec(log ?? '')?.[1] ?? null;
}

export function countGraph(g) {
  const confidence = {};
  for (const e of g.links) confidence[e.confidence ?? 'UNLABELED'] = (confidence[e.confidence ?? 'UNLABELED'] ?? 0) + 1;
  return { nodes: g.nodes.length, edges: g.links.length, confidence };
}

/**
 * Deterministic doc -> code links. Graphify's semantic pass links documents to
 * documents; this adds what a document names on a given line:
 *   EXTRACTED   a repository path that exists as a file node
 *   INFERRED    a `symbol` in backticks whose camel/Pascal/snake label is unique
 *   UNVERIFIED  a named path with no file node (listed, never turned into an edge)
 */
export async function linkDocs(repo, graph) {
  const g = { ...graph, links: [...graph.links] };
  const fileNode = new Map();
  for (const n of g.nodes) {
    if (!CODE.test(n.source_file ?? '')) continue;
    const cur = fileNode.get(n.source_file);
    if (!cur || (!n.source_location && cur.source_location)) fileNode.set(n.source_file, n);
  }
  const byLabel = new Map();
  for (const n of g.nodes) {
    if (!CODE.test(n.source_file ?? '') || !n.source_location) continue;
    const label = String(n.label ?? '').replace(/\(\)$/, '');
    // Plain words (`main`, `body`) collide with prose and git terms.
    if (!/^[A-Za-z_$][\w$]{3,}$/.test(label) || !/[A-Z_]/.test(label.slice(1))) continue;
    byLabel.set(label, [...(byLabel.get(label) ?? []), n]);
  }
  const docNode = new Map();
  for (const n of g.nodes) if (DOC.test(n.source_file ?? '') && !docNode.has(n.source_file)) docNode.set(n.source_file, n);
  const pathRe = /(?:^|[\s`(\["'])((?:\.\/)?(?:[\w@-]+\/)+[\w.@-]+\.(?:ts|tsx|svelte|mjs|cjs|js|jsx|py|ps1|css))/g;
  const symRe = /`([A-Za-z_$][\w$]{3,})(?:\(\))?`/g;
  const seen = new Set(g.links.map(e => `${e.source}>${e.target}`));
  const stats = { extracted: 0, inferred: 0, ambiguous: 0, unverified: [] };
  for (const [file, dn] of docNode) {
    let text;
    try { text = await fs.readFile(path.join(repo, file), 'utf8'); } catch { continue; }
    text.split(/\r?\n/).forEach((line, i) => {
      const at = `L${i + 1}`;
      for (const m of line.matchAll(pathRe)) {
        const rel = m[1].replace(/^\.\//, '');
        const target = fileNode.get(rel);
        if (!target) { stats.unverified.push({ doc: file, line: i + 1, path: rel }); continue; }
        if (seen.has(`${dn.id}>${target.id}`)) continue;
        seen.add(`${dn.id}>${target.id}`);
        g.links.push({ source: dn.id, target: target.id, relation: 'documents', confidence: 'EXTRACTED', confidence_score: 1, source_file: file, source_location: at, _origin: 'claudex-link-docs' });
        stats.extracted++;
      }
      for (const m of line.matchAll(symRe)) {
        const hits = byLabel.get(m[1]);
        if (!hits) continue;
        if (hits.length !== 1) { stats.ambiguous++; continue; }
        if (seen.has(`${dn.id}>${hits[0].id}`)) continue;
        seen.add(`${dn.id}>${hits[0].id}`);
        g.links.push({ source: dn.id, target: hits[0].id, relation: 'mentions', confidence: 'INFERRED', confidence_score: 0.7, source_file: file, source_location: at, _origin: 'claudex-link-docs' });
        stats.inferred++;
      }
    });
  }
  return { graph: g, stats };
}

/** CURRENT when the graph was built from exactly this repository snapshot. */
export async function graphStatus(ws, repo = ws.project) {
  if (!(await exists(stateFile(ws))) || !(await exists(linkedFile(ws)))) return { status: 'MISSING' };
  const state = await readJSON(stateFile(ws));
  const current = await snapshot(repo);
  const status = state.stable && state.snapshot?.digest === current.digest ? 'CURRENT' : 'STALE';
  return { status, builtAt: state.builtAt, head: state.head, built: state.snapshot, current, counts: state.counts, docCode: state.docCode };
}

/**
 * The slice of a CURRENT graph a job with these paths should see: nodes in its
 * files, their direct edges, and every document edge into them, each line
 * tagged with its confidence. A stale or missing graph yields a note, never
 * old edges presented as current.
 */
export async function projectGraph(ws, repo, paths, { limit = 120 } = {}) {
  const st = await graphStatus(ws, repo);
  if (st.status !== 'CURRENT') return { status: st.status, text: `Code graph: ${st.status}; not provided. Navigate from source.` };
  const g = await readJSON(linkedFile(ws));
  const norm = p => p.replaceAll('\\', '/');
  const inScope = f => f && paths.some(p => norm(f) === norm(p) || norm(f).startsWith(`${norm(p)}/`));
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const lines = [];
  const where = n => `${n.source_file ?? '?'}${n.source_location ? `:${String(n.source_location).replace(/^L/, '')}` : ''}`;
  const ranked = g.links.filter(e => {
    const a = byId.get(e.source), b = byId.get(e.target);
    return a && b && (inScope(a.source_file) || inScope(b.source_file)) && a.source_file !== b.source_file;
  }).sort((x, y) => (DOC.test(byId.get(y.source)?.source_file ?? '') - DOC.test(byId.get(x.source)?.source_file ?? '')));
  for (const e of ranked.slice(0, limit)) {
    const a = byId.get(e.source), b = byId.get(e.target);
    lines.push(`[${e.confidence ?? 'UNLABELED'}] ${a.label} (${where(a)}) -${e.relation}-> ${b.label} (${where(b)})`);
  }
  const more = ranked.length > limit ? `\n(+${ranked.length - limit} more edges omitted)` : '';
  return { status: 'CURRENT', edges: Math.min(ranked.length, limit), text: `Code graph (data, snapshot ${st.current.digest.slice(0, 12)}; EXTRACTED = stated in source, INFERRED = derived, confirm in source before relying on it):\n${lines.join('\n')}${more}` };
}

/** Pass a navigation command through to Graphify against the linked graph. */
export async function graphCommand(ws, args) {
  const cfg = ws.config.graph ?? {};
  assert(cfg.python, 'Set graph.python in local workspace.json');
  assert(['query', 'path', 'explain', 'affected', 'god-nodes'].includes(args[0]), 'Supported: query, path, explain, affected, god-nodes');
  const env = { ...process.env, PYTHONPATH: path.join(ROOT, 'vendor'), PYTHONIOENCODING: 'utf-8', PYTHONHASHSEED: '0' };
  return run(cfg.python, ['-m', 'graphify', ...args, '--graph', linkedFile(ws)], { cwd: os.tmpdir(), env });
}
