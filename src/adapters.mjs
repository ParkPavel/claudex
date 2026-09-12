import path from 'node:path';
import fs from 'node:fs/promises';
import { ROOT, assert, readJSON } from './io.mjs';
import { commandSpec, runCommand } from './process.mjs';

export async function prepareAdapter(ws, packet, role) {
  const command = ws.config.executables[role.provider];
  const spec = await commandSpec(command);
  const helpArgs = role.provider === 'codex' ? ['exec','--help'] : ['--help'];
  const help = (await runCommand(command, helpArgs)).stdout;
  const version = (await runCommand(command, ['--version'])).stdout.trim();
  // Packet first, then what this role was assigned, then the provider default.
  // A role that names its own model keeps it: a provider-wide default must not
  // silently flatten every role onto one model.
  const model = packet.model || role.model || ws.config.models[role.provider];
  assert(model, `No model for ${role.provider}. Set it for this role in the setup window, or as the provider default in local workspace.json`);
  assert(/^[a-zA-Z0-9._:/-]+$/.test(model), 'Invalid model identifier');
  const effort = packet.effort || role.effort;
  assert(['low','medium','high','xhigh','max'].includes(effort), 'Invalid effort');
  let args;
  if (role.provider === 'codex') {
    for (const flag of ['--ignore-user-config','--sandbox','--output-schema','--json']) assert(help.includes(flag), `Codex lacks required capability ${flag}`);
    // This adapter only serves read-only roles. No --write or bypass fallback exists.
    assert(packet.authority === 'read-only', 'Codex role cannot acquire write authority');
    args = ['exec','--ignore-user-config','--ephemeral','--disable','multi_agent','--disable','multi_agent_v2','--sandbox','read-only','-c','approval_policy="never"','-m',model,'-c',`model_reasoning_effort=${JSON.stringify(effort)}`,'--json','--output-schema',path.join(ROOT,'config/result.schema.json'),'-'];
    if (process.platform === 'win32') args.splice(1,0,'-c','windows.sandbox="elevated"');
  } else {
    for (const flag of ['--restricted','--safe-mode','--tools','--strict-mcp-config','--json-schema']) assert(help.includes(flag), `Claude lacks required capability ${flag}`);
    const tools = packet.authority === 'workspace-write' ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep';
    // Safe mode preserves native subscription authentication; bare mode skips OAuth.
    args = ['--restricted','--safe-mode','--print','--output-format','stream-json','--verbose','--no-session-persistence','--model',model,'--effort',effort,'--tools',tools,'--allowedTools',tools,'--disallowedTools','mcp__*','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--permission-mode','dontAsk','--json-schema',await fs.readFile(path.join(ROOT,'config/result.schema.json'),'utf8')];
  }
  return { spec, args, version, model, effort, provider: role.provider };
}
export function readyEvent(event, provider) {
  return provider === 'codex' ? ['thread.started','turn.started'].includes(event.type) : event.type === 'system' && event.subtype === 'init';
}
export function resultEvent(event, provider) {
  if (provider === 'claude' && event.type === 'result') {
    if (event.is_error) throw new Error('Claude returned an error result');
    return event.structured_output || (event.result ? JSON.parse(event.result) : null);
  }
  if (provider === 'codex' && event.type === 'item.completed' && event.item?.type === 'agent_message') return JSON.parse(event.item.text);
  return null;
}
export async function validatePacket(packet) {
  assert(packet && typeof packet === 'object', 'Invalid packet');
  assert(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,70}$/.test(packet.taskId || ''), 'Invalid task ID');
  const roles = await readJSON(path.join(ROOT,'config/roles.json'));
  const role = roles[packet.role];
  assert(role, 'Unknown role');
  assert(['snapshot','design','diff','live','eval'].includes(packet.mode), 'Unknown task mode');
  assert(typeof packet.goal === 'string' && packet.goal.trim(), 'Missing goal');
  assert(Array.isArray(packet.paths) && packet.paths.every(p => typeof p === 'string' && p.length > 0), 'paths must be an array of repository-relative paths');
  assert(Array.isArray(packet.criteria) && packet.criteria.length && packet.criteria.every(c => typeof c.id === 'string' && typeof c.text === 'string' && c.text.trim()), 'Missing acceptance criteria');
  assert(new Set(packet.criteria.map(c => c.id)).size === packet.criteria.length, 'Duplicate criterion ID');
  assert(['read-only','workspace-write'].includes(packet.authority), 'Explicit authority required');
  assert(!(packet.authority === 'workspace-write' && role.authority !== 'workspace-write'), 'Role authority cannot be escalated');
  if (packet.authority === 'workspace-write') assert(packet.worktree, 'A writer requires an assigned worktree');
  if (packet.mode === 'diff') assert(packet.base, 'Diff review requires a base');
  return role;
}
export function validateResult(result, packet) {
  assert(result && result.taskId === packet.taskId, 'Result task identity mismatch');
  assert(Array.isArray(result.criteria) && result.criteria.length === packet.criteria.length, 'Incomplete criterion results');
  assert(new Set(result.criteria.map(c => c.id)).size === result.criteria.length, 'Duplicate criterion result');
  for (const expected of packet.criteria) {
    const found = result.criteria.find(c => c.id === expected.id);
    assert(found && ['PASS','FAIL','UNKNOWN'].includes(found.status), 'Invalid criterion result');
    assert(Array.isArray(found.evidence) && found.evidence.every(e=>typeof e==='string' && e.trim()) && (found.status !== 'PASS' || found.evidence.length > 0), 'PASS requires evidence');
  }
  assert(Array.isArray(result.findings) && Array.isArray(result.unknowns), 'Malformed findings or unknowns');
  return result;
}
