import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assert, exec, exists } from './io.mjs';

export async function commandSpec(command) {
  assert(typeof command === 'string' && command.length > 0, 'Missing executable');
  let executable = command;
  if (process.platform === 'win32' && !path.isAbsolute(command)) {
    const found = (await exec('where.exe', [command], { windowsHide: true })).stdout.trim().split(/\r?\n/);
    // Prefer the user's first installation, resolving npm shims without cmd.exe.
    const shim = found.find(p => p.endsWith('.cmd'));
    if (shim) executable = shim;
    else executable = found.find(p => /\.(exe|com)$/i.test(p)) || found[0];
  }
  if (process.platform === 'win32' && /\.(cmd|ps1)$/i.test(executable)) {
    const base = path.dirname(executable);
    const known = { codex: ['node_modules/@openai/codex/bin/codex.js'], claude: ['node_modules/@anthropic-ai/claude-code/bin/claude.exe','node_modules/@anthropic-ai/claude-code/cli.js'], npm: ['node_modules/npm/bin/npm-cli.js'] };
    const name = path.basename(executable).replace(/\.(cmd|ps1)$/i, '');
    for (const relative of known[name] || []) {
      const script = path.join(base, relative);
      if (await exists(script)) return /\.exe$/i.test(script) ? { executable:script,prefix:[],identity:script } : { executable: process.execPath, prefix: [script], identity: script };
    }
    throw new Error(`Unsupported shell shim for ${name}. Configure a native executable or supported npm installation.`);
  }
  if (/\.[mc]?js$/i.test(executable)) return { executable:process.execPath,prefix:[executable],identity:executable };
  return { executable, prefix: [], identity: executable };
}
export async function runCommand(command, args, options = {}) {
  const spec = await commandSpec(command);
  return exec(spec.executable, [...spec.prefix, ...args], { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...options });
}
export function stopTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    return exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}
export function spawnSpec(spec, args, cwd) {
  return spawn(spec.executable, [...spec.prefix, ...args], { cwd, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
}
