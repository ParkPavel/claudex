import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assert, atomicJSON, contained, exists, sha, snapshot, runtimeDigest, readJSON } from './io.mjs';
import { runCommand } from './process.mjs';

const operations = {
  'version': [], 'files': ['folder','ext','total'], 'read': ['path'],
  'dev:errors': [], 'dev:console': ['limit','level'], 'dev:dom': ['selector','attr','css','total','text','inner','all'],
  'dev:css': ['selector','prop'], 'dev:screenshot': [], 'plugins': ['filter','versions','format'],
  'plugin:reload': ['id'], 'create': ['path','content'], 'append': ['path','content'],
  'property:set': ['path','name','value','type'], 'eval': ['code']
};
const mutations = new Set(['plugin:reload','create','append','property:set','eval']);
export function obsidianArgs(vault, operation, params) {
  assert(typeof vault === 'string' && vault.length > 0 && !/[\r\n\0]/.test(vault),'Explicit vault identity required');
  assert(Object.hasOwn(operations,operation),'Unsupported Obsidian operation');
  for (const [key,value] of Object.entries(params)) {
    assert(operations[operation].includes(key),`Unsupported parameter ${key}`);
    assert(typeof value === 'string' || typeof value === 'boolean','Parameters must be strings or boolean flags');
    assert(!String(value).includes('\0'),'NUL is not allowed');
  }
  return [`vault=${vault}`,operation,...Object.entries(params).filter(([,v])=>v!==false).map(([k,v])=>v===true?k:`${k}=${v}`)];
}
export async function obsidianHealth(ws) {
  const executable = ws.config.executables.obsidian;
  const version = (await runCommand(executable,['version'])).stdout.trim();
  const help = (await runCommand(executable,['help'])).stdout;
  assert(help.includes('dev:dom') && help.includes('plugin:reload'),'Obsidian developer CLI is unavailable');
  return { version, developerCLI:true };
}
export function parseVaultIdentity(output) {
  const raw = output.trim().replace(/^=>\s*/, '');
  try { return JSON.parse(raw); } catch { return raw; }
}
export async function obsidian(ws,operation,params={}, { write = false }={}) {
  const config = ws.config.obsidian;
  const args = obsidianArgs(config.vault,operation,params);
  assert(config.vaultPath,'Configure the absolute test vault path locally');
  const vaultRoot = await fs.realpath(config.vaultPath);
  if (mutations.has(operation)) {
    assert(write && config.testVault === true,'Mutation requires --write and an explicitly designated test vault');
  }
  if (['read','create','append','property:set'].includes(operation)) assert(params.path,'An exact vault-relative path is required');
  if (params.path) {
    assert(!path.isAbsolute(params.path),'Vault paths must be relative');
    await contained(vaultRoot,path.resolve(vaultRoot,params.path));
  }
  const identity = await runCommand(ws.config.executables.obsidian,[`vault=${config.vault}`,'eval','code=app.vault.adapter.getBasePath()']);
  const reported = parseVaultIdentity(identity.stdout);
  assert(typeof reported === 'string' && path.resolve(reported) === path.resolve(vaultRoot),'Obsidian selected a different vault; operation refused');
  const id = `obsidian-${Date.now()}-${crypto.randomUUID()}`;
  const dir = path.join(ws.state,'artifacts',id);
  await fs.mkdir(dir,{recursive:true});
  if (operation === 'dev:screenshot') args.push(`path=${path.join(dir,'screenshot.png')}`);
  const sourceBefore=await snapshot(ws.project);
  const configurationDigest=await runtimeDigest(ws);
  const bundles={};
  const manifestPath=path.join(ws.project,'manifest.json');
  if(await exists(manifestPath)) {
    const manifest=await readJSON(manifestPath);
    assert(/^[a-zA-Z0-9_-]+$/.test(manifest.id),'Invalid plugin id for bundle binding');
    for(const [label,file] of Object.entries({source:path.join(ws.project,'main.js'),deployed:path.join(vaultRoot,'.obsidian','plugins',manifest.id,'main.js')})) {
      if(await exists(file))bundles[label]=sha(await fs.readFile(file));
    }
  }
  const start = new Date().toISOString();
  const result = await runCommand(ws.config.executables.obsidian,args,{timeout:30000});
  await fs.writeFile(path.join(dir,'stdout.txt'),result.stdout,{mode:0o600});
  await fs.writeFile(path.join(dir,'stderr.txt'),result.stderr,{mode:0o600});
  const files = { stdout:sha(result.stdout), stderr:sha(result.stderr) };
  if (await exists(path.join(dir,'screenshot.png'))) files.screenshot = sha(await fs.readFile(path.join(dir,'screenshot.png')));
  const sourceAfter=await snapshot(ws.project);
  const freshness=sourceBefore.digest===sourceAfter.digest && configurationDigest===await runtimeDigest(ws) ? 'CURRENT' : 'STALE';
  const record = { id,operation,vault:config.vault,vaultPath:vaultRoot,started:start,finished:new Date().toISOString(),mutation:mutations.has(operation),files,sourceBefore,sourceAfter,configurationDigest,freshness,bundles,acceptance:'UNKNOWN',note:'Command execution alone does not prove behavioral acceptance.' };
  await atomicJSON(path.join(dir,'evidence.json'),record);
  return { ...record, artifactDirectory:dir };
}
