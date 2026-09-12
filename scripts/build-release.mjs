import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const outputDirectory = path.join(root, 'artifacts');
const archive = path.join(outputDirectory, `${metadata.name}-${metadata.version}.zip`);

const git = args => exec('git', ['-C', root, ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
const status = (await git(['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim();
if (status) throw new Error('Release archives are built only from a clean committed tree. Commit or remove the listed changes first.');

await fs.mkdir(outputDirectory, { recursive: true });
await fs.rm(archive, { force: true });
await git(['archive', '--format=zip', '--prefix=claudex/', `--output=${archive}`, 'HEAD']);

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-release-'));
try {
  if (process.platform === 'win32') {
    await exec('powershell', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1]', archive, temporary], { windowsHide: true });
  } else {
    await exec('unzip', ['-q', archive, '-d', temporary]);
  }

  const packaged = path.join(temporary, 'claudex');
  const required = [
    'bin/claudex.mjs', 'config/core.md', 'config/roles.json',
    'profiles/generic.json', 'skills/task-contract/SKILL.md',
    'examples/map-task.json', 'setup.cmd', 'setup.sh',
    'README.md', 'README.ru.md', 'LICENSE',
  ];
  const excluded = ['test', 'scripts', 'docs/research', '.github', '.githooks', 'package-lock.json'];
  for (const relative of required) await fs.access(path.join(packaged, relative));
  for (const relative of excluded) {
    const present = await fs.access(path.join(packaged, relative)).then(() => true, () => false);
    if (present) throw new Error(`Development-only path leaked into the release: ${relative}`);
  }

  async function verifyLinks(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) { await verifyLinks(file); continue; }
      if (!item.name.endsWith('.md')) continue;
      const body = await fs.readFile(file, 'utf8');
      for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1];
        if (/^(https?:|#|mailto:)/.test(target)) continue;
        const destination = path.resolve(path.dirname(file), target.split('#')[0]);
        const present = await fs.access(destination).then(() => true, () => false);
        if (!present) throw new Error(`Broken packaged documentation link: ${path.relative(packaged, file)} -> ${target}`);
      }
    }
  }
  await verifyLinks(packaged);
  await exec(process.execPath, [path.join(packaged, 'bin', 'claudex.mjs'), 'help'], { windowsHide: true });
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

const bytes = await fs.readFile(archive);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
await fs.writeFile(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`, 'utf8');
console.log(JSON.stringify({ archive, bytes: bytes.length, sha256, source: (await git(['rev-parse', 'HEAD'])).stdout.trim() }, null, 2));
