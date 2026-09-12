// The local workspace configuration: what it may contain, what an older file
// becomes when this version reads it, and who answers for each role.
//
// This module is deliberately free of I/O and of imports from the rest of the
// harness, so that reading a configuration cannot depend on the state it
// describes. It throws plain errors; the caller decides what to do with them.

export const CONFIG_VERSION = 2;

/**
 * How much the harness may do without asking. The mode is a property of the
 * installation, chosen by the person who installed it, and every writing job
 * is measured against it.
 *
 * - `full`     — a writer runs as soon as its packet is valid.
 * - `scoped`   — a writer runs only in its own worktree on a feature branch.
 * - `approval` — a writer additionally needs a one-shot approval recorded by a
 *                human for that exact task.
 */
export const ACCESS = ['full', 'scoped', 'approval'];
export const PROVIDERS = ['claude', 'codex'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]+$/;

/** Examples, not a catalogue: model names change faster than this file does. */
export const MODEL_EXAMPLES = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-sol'],
};

const fail = message => { throw new Error(message); };
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function defaultConfig({ project, profile = 'generic', vault = null, url = 'https://github.com/ParkPavel/claudex' }) {
  return {
    schemaVersion: CONFIG_VERSION,
    project,
    profile,
    repositoryUrl: url,
    // An installation that has not been configured asks before it writes. The
    // person installing it can widen that in the setup window; nothing widens
    // it on their behalf.
    access: 'approval',
    maxWorkers: 3,
    models: { codex: null },
    assignments: {},
    executables: { codex: 'codex', claude: 'claude', obsidian: 'obsidian' },
    obsidian: { vault, vaultPath: null, testVault: false },
    readyTimeoutMs: 60000,
    runTimeoutMs: 900000,
  };
}

/**
 * Read an older configuration as this version understands it. Version 1 had no
 * access mode and no per-role assignments; it is read as `scoped`, because that
 * is what version 1 actually enforced — a writer needed its own worktree on a
 * feature branch, and nothing more. Calling it `approval` would claim a
 * protection those installations never had.
 */
export function migrateConfig(raw) {
  isObject(raw) || fail('Malformed workspace configuration');
  const version = raw.schemaVersion;
  version === 1 || version === CONFIG_VERSION || fail(`Unsupported workspace configuration version ${version}`);
  const config = { ...raw, schemaVersion: CONFIG_VERSION };
  if (version === 1) {
    config.access = 'scoped';
    config.assignments = {};
  }
  config.access ??= 'scoped';
  config.assignments ??= {};
  config.models ??= {};
  return { config, migrated: version !== CONFIG_VERSION, from: version };
}

export function validateConfig(config, roles) {
  isObject(config) || fail('Malformed workspace configuration');
  ACCESS.includes(config.access) || fail(`Unknown access mode ${config.access}; expected ${ACCESS.join(', ')}`);
  Number.isInteger(config.maxWorkers) && config.maxWorkers > 0 || fail('maxWorkers must be a positive integer');
  isObject(config.assignments) || fail('assignments must be an object of role overrides');
  for (const [name, assignment] of Object.entries(config.assignments)) {
    roles?.[name] || fail(`Assignment for unknown role ${name}`);
    isObject(assignment) || fail(`Malformed assignment for ${name}`);
    for (const key of Object.keys(assignment)) ['provider', 'model', 'effort'].includes(key) || fail(`Unknown assignment field ${key} for ${name}`);
    if (assignment.provider !== undefined) PROVIDERS.includes(assignment.provider) || fail(`Unknown provider ${assignment.provider} for ${name}`);
    if (assignment.effort !== undefined) EFFORTS.includes(assignment.effort) || fail(`Unknown effort ${assignment.effort} for ${name}`);
    if (assignment.model !== undefined && assignment.model !== null) {
      (typeof assignment.model === 'string' && MODEL_PATTERN.test(assignment.model)) || fail(`Invalid model identifier for ${name}`);
    }
    // A role that writes cannot be moved to a provider whose adapter is
    // read-only. Refusing here is the difference between a setup mistake and a
    // job that fails at three in the morning.
    if (assignment.provider === 'codex' && roles[name].authority !== 'read-only') {
      fail(`Role ${name} needs ${roles[name].authority}; codex serves read-only roles only`);
    }
  }
  return config;
}

/** Who answers for this role, and with what: assignment first, role default second. */
export function resolveAssignment(config, name, role) {
  const assignment = config.assignments?.[name] ?? {};
  const provider = assignment.provider ?? role.provider;
  return {
    ...role,
    provider,
    model: assignment.model ?? (provider === role.provider ? role.model : null),
    effort: assignment.effort ?? role.effort,
    assigned: Boolean(assignment.provider || assignment.model || assignment.effort),
  };
}
