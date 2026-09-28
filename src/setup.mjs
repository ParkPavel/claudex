import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, exists, git, inside, readJSON } from './io.mjs';
import { runCommand } from './process.mjs';
import { ACCESS, MODEL_EXAMPLES, MODEL_PATTERN, PROVIDERS, EFFORTS, resolveAssignment } from './config.mjs';

// The window a person meets when they install this harness on their own machine.
//
// Everything it asks is a decision the installation cannot make for someone
// else: which project is managed, what the harness may do without asking, and
// which model answers for which role. Everything it does not ask has a default
// that errs towards asking rather than acting.
//
// The prompts are injected, so the whole conversation is exercised by tests
// without a terminal.

const WIDTH = 76;
const INNER = WIDTH - 4;
const line = text => `│ ${String(text).padEnd(INNER)} │`;
const rule = (left, right) => `${left}${'─'.repeat(WIDTH - 2)}${right}`;

/**
 * A frame that never eats its own explanation. Long text wraps at word
 * boundaries, keeping the indentation of the line it came from, because the
 * first version cut sentences mid-word and hid the thing it was explaining.
 */
export function wrap(text) {
  const value = String(text).replace(/\s+$/, '');
  if (value.length <= INNER) return [value];
  // Words carry their own trailing spaces, so a line that fits keeps the column
  // alignment it was written with; only a line too long to fit is re-flowed.
  const indent = value.match(/^\s*/)[0];
  const words = value.slice(indent.length).match(/\S+\s*/g) ?? [];
  const lines = [];
  let current = indent;
  for (const word of words) {
    if (`${current}${word}`.trimEnd().length > INNER && current.trim()) { lines.push(current.trimEnd()); current = `${indent}${word}`; }
    else current += word;
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.flatMap(item => (item.length <= INNER ? [item] : item.match(new RegExp(`.{1,${INNER}}`, 'g'))));
}

export function frame(title, body) {
  return [rule('┌', '┐'), line(title), line(''), ...body.flatMap(wrap).map(line), rule('└', '┘')].join('\n');
}

export const LAYOUT = [
  '.claudex.json         pointer to the local state directory',
  '.local/claudex/       configuration, jobs, evidence, approvals, reports',
  '  …/worktrees/        isolated checkouts for writing tasks',
  '.tmp/                 disposable scratch space',
  'AGENTS.md, CLAUDE.md  generated entrypoints to the shared contract',
  '.codex/ .claude/      generated native role definitions',
  '.agents/              generated skill entrypoints',
];

const ACCESS_TEXT = {
  full: 'a writing task runs as soon as its packet is valid',
  scoped: 'a writing task runs only in its own worktree, on a feature branch',
  approval: 'a writing task also needs your one-shot approval for that task',
};

async function ask(io, prompt, { fallback = null, choices = null, validate = null } = {}) {
  while (true) {
    const answer = (await io.question(`${prompt}${fallback ? ` [${fallback}]` : ''}: `)).trim();
    const value = answer || fallback || '';
    if (choices && !choices.includes(value)) { io.write(`Choose one of: ${choices.join(', ')}\n`); continue; }
    if (validate) {
      const problem = await validate(value);
      if (problem) { io.write(`${problem}\n`); continue; }
    }
    return value;
  }
}

/** A directory that is a Git root inside the workspace: the only thing this harness can manage. */
export async function projectProblem(root, candidate) {
  if (!candidate) return 'Name the folder of the project this harness will manage.';
  const target = path.resolve(root, candidate);
  if (path.resolve(target) === path.resolve(root)) return 'The workspace root cannot be the managed project; the project lives inside it.';
  if (!inside(root, target)) return `${target} is outside the workspace. Choose a Git repository inside ${root}.`;
  if (!(await exists(target))) return `${target} does not exist. Create or clone the project first.`;
  const top = await git(target, ['rev-parse', '--show-toplevel']).then(value => value.trim(), () => null);
  if (!top || path.resolve(top) !== path.resolve(target)) return `${target} is not a Git root. Claudex manages a repository, not a folder inside one.`;
  return null;
}

export async function chooseProject(io, root, current = null) {
  io.write(`${frame('Managed project', [
    `Workspace: ${root}`,
    'Name the project folder, relative to this workspace. It must be its own Git repository; the harness never manages the workspace root itself.',
    '',
    'These are created next to it, and none of them belong in a public repository:',
    ...LAYOUT.map(item => `  ${item}`),
  ])}\n`);
  return ask(io, 'project folder', { fallback: current, validate: value => projectProblem(root, value) });
}

/**
 * What this machine can run, shown before any question. A missing provider CLI
 * or an old Node is found here instead of by the first job that fails; a model
 * a CLI cannot serve is still only found by a run (doctor says so).
 */
export async function probeEnvironment(executables = {}) {
  const version = async (command, args = ['--version']) => {
    try { return { found: true, version: (await runCommand(command, args, { timeout: 15000 })).stdout.trim().split(/\r?\n/)[0] }; }
    catch (error) { return { found: false, version: null, problem: error.code === 'ENOENT' || /not found|not recognized|Missing|Unsupported/i.test(error.message) ? 'not installed or not on PATH' : error.message.split('\n')[0] }; }
  };
  const major = Number(process.versions.node.split('.')[0]);
  return [
    { name: 'node', found: true, version: process.version, problem: major >= 22 ? null : 'Claudex needs Node.js 22 or newer' },
    { name: 'git', ...(await version('git')) },
    ...(await Promise.all(PROVIDERS.map(async provider => ({ name: provider, ...(await version(executables[provider] ?? provider)) })))),
  ];
}
export function environmentFrame(rows) {
  const missing = rows.filter(row => !row.found || row.problem);
  return frame('Environment', [
    ...rows.map(row => `${row.name.padEnd(8)} ${row.found ? row.version : '—'}${row.problem ? `  ! ${row.problem}` : ''}`),
    '',
    missing.length ? 'Roles of a missing provider cannot run until it is installed and logged in; you can continue and fix it later.' : 'Everything the harness launches was found. Logins and model access are checked by the first run.',
  ]);
}

/** The profile a project looks like, offered as the default. A suggestion; the person chooses. */
export async function detectProfile(projectPath) {
  if (!projectPath) return 'generic';
  const has = file => exists(path.join(projectPath, file));
  if (await has('manifest.json') && await has('package.json')) {
    const manifest = await readJSON(path.join(projectPath, 'manifest.json')).catch(() => ({}));
    if (manifest.minAppVersion || manifest.isDesktopOnly !== undefined) return 'obsidian';
  }
  return 'generic';
}

/** Package scripts that look like checks, in the order a person would run them. */
export async function suggestedChecks(projectPath) {
  const pkg = projectPath ? await readJSON(path.join(projectPath, 'package.json')).catch(() => null) : null;
  const scripts = Object.keys(pkg?.scripts ?? {});
  return ['build', 'test', 'lint', 'check', 'typecheck', 'svelte-check'].filter(name => scripts.includes(name)).map(name => (name === 'test' ? 'npm test' : `npm run ${name}`));
}

// Decisions an agent cannot take for the person and must not infer from a relay.
// A subagent told "the user agreed" has received a relay, not consent, and a
// ticket that waits for such consent inside a pipeline can never be resolved.
// Recording them once, where every role reads them, makes them durable.
export const PRINCIPLES_START = '<!-- claudex:principles:start -->';
export const PRINCIPLES_END = '<!-- claudex:principles:end -->';
export function principlesSection(p, date = new Date().toISOString().slice(0, 10)) {
  return [
    PRINCIPLES_START,
    `## Working principles (recorded by claudex setup, ${date})`,
    '',
    `- Answer the person in: ${p.language}.`,
    `- Protected branch: ${p.branch}. Changes reach it only through a pull request; never push to it directly.`,
    p.merge === 'person'
      ? "- Merging is the person's act: agents prepare the pull request and stop."
      : '- An agent may merge a pull request whose required checks are green and whose review is recorded.',
    `- Checks before claiming completion: ${p.checks || 'the project states none; ask before inventing one'}.`,
    '- A decision the person made is recorded here or in the task contract before a pipeline runs. A relayed "the user agreed" is not consent; an unresolved decision skips its ticket instead of stopping the queue.',
    PRINCIPLES_END,
  ].join('\n');
}
export function readPrinciples(text) {
  const start = text?.indexOf(PRINCIPLES_START) ?? -1;
  const end = text?.indexOf(PRINCIPLES_END) ?? -1;
  if (start < 0 || end < start) return null;
  const block = text.slice(start, end);
  const pick = pattern => block.match(pattern)?.[1]?.trim() ?? null;
  return {
    language: pick(/Answer the person in: (.+?)\.\n/),
    branch: pick(/Protected branch: (\S+?)\. /),
    merge: /Merging is the person/.test(block) ? 'person' : 'agent',
    checks: pick(/Checks before claiming completion: (.+?)\.\n/),
  };
}
/** Replaces an earlier recorded section and keeps everything the person wrote around it. */
export function mergePrinciples(text, section) {
  const current = text ?? '';
  const start = current.indexOf(PRINCIPLES_START);
  const end = current.indexOf(PRINCIPLES_END);
  if (start >= 0 && end > start) return `${current.slice(0, start)}${section}${current.slice(end + PRINCIPLES_END.length)}`;
  return `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${section}\n`;
}
export async function choosePrinciples(io, { current = null, checks = [] } = {}) {
  io.write(`${frame('Working principles', [
    'Decisions every role reads before it acts, so nobody has to relay them. They are written into the local project profile; run setup again to change them.',
  ])}\n`);
  const language = await ask(io, 'language to answer you in', { fallback: current?.language ?? 'English' });
  const branch = await ask(io, 'protected branch', { fallback: current?.branch ?? 'main', validate: value => (/^[\w./-]+$/.test(value) ? null : 'A branch name.') });
  const merge = await ask(io, 'who merges pull requests (person/agent)', { fallback: current?.merge ?? 'person', choices: ['person', 'agent'] });
  const checks_ = await ask(io, 'checks before claiming completion (comma-separated)', { fallback: current?.checks ?? (checks.join(', ') || null) });
  return { language, branch, merge, checks: checks_ };
}

export async function chooseProfile(io, current = 'generic') {
  const profiles = (await fs.readdir(path.join(ROOT, 'profiles'))).filter(name => name.endsWith('.json')).map(name => name.replace(/\.json$/, ''));
  io.write(`${frame('Project profile', [
    'A profile carries the checks and the working instructions for a kind of project. `generic` states the contract only; `obsidian` adds plugin checks and live evidence through the Obsidian CLI.',
    '',
    `Available: ${profiles.join(', ')}`,
  ])}\n`);
  return ask(io, 'profile', { fallback: current, choices: profiles });
}

export async function chooseAccess(io, current = 'approval') {
  io.write(`${frame('What the harness may do without asking', [
    ...ACCESS.map(mode => `${mode.padEnd(9)} ${ACCESS_TEXT[mode]}`),
    '',
    'Reading and reviewing are never gated: the modes differ in what may be changed, not in what may be looked at.',
    '`approval` is the default, and an approval is one task, one use:',
    '  claudex approve <task> --reason "<why>"',
  ])}\n`);
  return ask(io, 'access mode', { fallback: current, choices: ACCESS });
}

export async function chooseProviders(io, current = {}) {
  io.write(`${frame('Providers', [
    'The executable each provider is launched with, and the model used when a role does not name one of its own. Authentication stays in your own CLI installations; nothing is copied here.',
    '',
    ...PROVIDERS.map(provider => `${provider.padEnd(8)} examples: ${MODEL_EXAMPLES[provider].join(', ')}`),
  ])}\n`);
  const executables = {};
  const models = {};
  for (const provider of PROVIDERS) {
    executables[provider] = await ask(io, `${provider} executable`, { fallback: current.executables?.[provider] ?? provider });
    const model = await ask(io, `${provider} default model (empty: role defaults)`, {
      fallback: current.models?.[provider] ?? '',
      validate: value => (!value || MODEL_PATTERN.test(value) ? null : 'A model identifier may contain letters, digits and . _ : / -'),
    });
    models[provider] = model || null;
  }
  return { executables, models };
}

export async function chooseObsidian(io, current = {}) {
  io.write(`${frame('Obsidian test vault', [
    'Live checks need an explicit vault identity and absolute local path. Mutations are allowed only when you mark this as a test vault; production vaults stay read-only.',
  ])}\n`);
  const executable = await ask(io, 'obsidian executable', { fallback: current.executables?.obsidian ?? 'obsidian' });
  const vault = await ask(io, 'vault name', {
    fallback: current.obsidian?.vault ?? null,
    validate: value => (value && !/[\r\n\0]/.test(value) ? null : 'Name the Obsidian vault exactly as the CLI knows it.'),
  });
  const vaultPath = await ask(io, 'absolute vault path', {
    fallback: current.obsidian?.vaultPath ?? null,
    validate: async value => {
      if (!path.isAbsolute(value)) return 'Use an absolute path to the local vault.';
      if (!(await exists(value))) return `${value} does not exist.`;
      return null;
    },
  });
  const testVault = await ask(io, 'allow test mutations in this vault? (yes/no)', {
    fallback: current.obsidian?.testVault ? 'yes' : 'no', choices: ['yes', 'no'],
  });
  return { executable, config: { vault, vaultPath: path.resolve(vaultPath), testVault: testVault === 'yes' } };
}

/**
 * Who answers for each role. One line per role, in the same shape as the
 * `--assign` flag, so the window and the script are the same language:
 * `provider`, `provider/model`, `provider/model@effort`, or nothing to keep the
 * default. `skip` stops the walk and keeps every role that has not been reached.
 *
 * The refusals are the ones the configuration enforces later: a role that writes
 * cannot move to a provider whose adapter is read-only, and the window says so
 * instead of letting the job fail at run time.
 */
export function parseAssignmentSpec(spec, role) {
  const [providerAndModel, effort] = String(spec).split('@');
  const [provider, model] = providerAndModel.split('/');
  if (provider && !PROVIDERS.includes(provider)) return { problem: `Choose one of: ${PROVIDERS.join(', ')}, or press Enter to keep ${role.provider}` };
  if (provider === 'codex' && role.authority !== 'read-only') return { problem: `This role needs ${role.authority}; codex serves read-only roles only` };
  if (model && !MODEL_PATTERN.test(model)) return { problem: 'A model identifier may contain letters, digits and . _ : / -' };
  if (effort && !EFFORTS.includes(effort)) return { problem: `Effort is one of: ${EFFORTS.join(', ')}` };
  const assignment = {};
  if (provider && provider !== role.provider) assignment.provider = provider;
  if (model && model !== role.model) assignment.model = model;
  if (effort && effort !== role.effort) assignment.effort = effort;
  return { assignment };
}

export async function chooseAssignments(io, { roles, config, current = {} }) {
  io.write(`${frame('Roles and models', [
    'One line per role: provider, provider/model, or provider/model@effort.',
    'Press Enter to keep what is shown. Type "skip" to keep every remaining role.',
    'A role that writes cannot move to a read-only provider; the window says so and asks again.',
    '',
    ...PROVIDERS.map(provider => `${provider.padEnd(8)} examples: ${MODEL_EXAMPLES[provider].join(', ')}`),
  ])}\n`);
  const assignments = { ...current };
  for (const [name, role] of Object.entries(roles)) {
    const resolved = resolveAssignment({ ...config, assignments }, name, role);
    const shown = `${resolved.provider}${resolved.model ? `/${resolved.model}` : ''}@${resolved.effort}`;
    // A refused answer re-asks this role. Moving on would apply the person's
    // correction to the next role in the list and quietly shift every choice
    // after it — the kind of mistake nobody notices until a job runs on the
    // wrong model.
    let stop = false;
    while (!stop) {
      const answer = (await io.question(`${name} (${role.authority}) [${shown}]: `)).trim();
      if (answer === 'skip') return assignments;
      if (!answer) break;
      const { assignment, problem } = parseAssignmentSpec(answer, role);
      if (problem) { io.write(`${problem}\n`); continue; }
      if (Object.keys(assignment).length) assignments[name] = assignment;
      else delete assignments[name];
      stop = true;
    }
  }
  return assignments;
}

export function summary(choices) {
  const assigned = Object.entries(choices.assignments ?? {});
  return frame('Summary', [
    `project    ${choices.project}`,
    `profile    ${choices.profile}`,
    `access     ${choices.access} — ${ACCESS_TEXT[choices.access]}`,
    ...PROVIDERS.map(provider => `${provider.padEnd(10)} ${choices.executables?.[provider] ?? provider}${choices.models?.[provider] ? ` · ${choices.models[provider]}` : ''}`),
    ...(choices.profile === 'obsidian' ? [
      `obsidian   ${choices.executables.obsidian}`,
      `vault      ${choices.obsidian.vault} · ${choices.obsidian.vaultPath}${choices.obsidian.testVault ? ' · test mutations allowed' : ' · read-only'}`,
    ] : []),
    ...(choices.principles ? [`principles ${choices.principles.language} · branch ${choices.principles.branch} · merge by ${choices.principles.merge} · checks: ${choices.principles.checks || 'none'}`] : []),
    ...(choices.hooks !== undefined ? [`hooks      ${choices.hooks ? 'install into .claude/settings.local.json' : 'not installed'}`] : []),
    assigned.length ? 'roles' : 'roles      every role keeps its default',
    ...assigned.map(([name, assignment]) => `  ${name}: ${Object.entries(assignment).map(([key, value]) => `${key}=${value}`).join(' ')}`),
  ]);
}

/** The whole conversation, for a new installation or for changing an existing one. */
export async function runSetup(io, { root, roles, config = null, project = null, probe = probeEnvironment, profileText = null } = {}) {
  const table = roles ?? await readJSON(path.join(ROOT, 'config/roles.json'));
  io.write(`${environmentFrame(await probe(config?.executables ?? {}))}\n`);
  const choices = { project: config ? config.project : await chooseProject(io, root, project) };
  const projectPath = path.resolve(root, choices.project);
  choices.profile = await chooseProfile(io, config?.profile ?? await detectProfile(projectPath));
  choices.access = await chooseAccess(io, config?.access ?? 'approval');
  Object.assign(choices, await chooseProviders(io, config ?? {}));
  if (choices.profile === 'obsidian') {
    const obsidian = await chooseObsidian(io, config ?? {});
    choices.executables.obsidian = obsidian.executable;
    choices.obsidian = obsidian.config;
  }
  choices.assignments = await chooseAssignments(io, { roles: table, config: config ?? { assignments: {} }, current: config?.assignments ?? {} });
  choices.principles = await choosePrinciples(io, { current: readPrinciples(profileText), checks: await suggestedChecks(projectPath) });
  io.write(`${frame('Claude Code hooks', [
    'Four hooks carry state between sessions: the handover at session start, a handoff line at each stop, finished job reports in the next turn, and a gate that refuses an unready writing job before it is submitted. They go into .claude/settings.local.json beside what is already there; the generated settings.json is left alone.',
  ])}\n`);
  choices.hooks = (await ask(io, 'install the hooks? (yes/no)', { fallback: 'yes', choices: ['yes', 'no'] })) === 'yes';
  io.write(`${summary(choices)}\n`);
  const confirmed = await ask(io, 'write this configuration? (yes/no)', { fallback: 'yes', choices: ['yes', 'no'] });
  return confirmed === 'yes' ? choices : null;
}
