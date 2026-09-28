#!/usr/bin/env node
// Download the distilled Apple HIG reference into library/apple-hig at a pinned commit.
//
// The source declares no license and restates Apple's guidelines, so it is not
// tracked in this repository: a published Claudex must not carry it. Each
// machine fetches it for local reference instead. Usage: node library/fetch-hig.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'https://github.com/justinwetch/HIGAgentSkills.git';
const COMMIT = '701151a7b39609b71a58d54de6d86e3500c0c316';
const target = path.join(path.dirname(fileURLToPath(import.meta.url)), 'apple-hig');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-hig-'));
const git = (...args) => execFileSync('git', ['-C', scratch, ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
try {
  git('init', '-q');
  git('fetch', '-q', '--depth', '1', REPOSITORY, COMMIT);
  git('checkout', '-q', 'FETCH_HEAD');
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const item of ['SKILL.md', 'routing-index.md', 'distilled']) fs.cpSync(path.join(scratch, item), path.join(target, item), { recursive: true });
  fs.writeFileSync(path.join(target, 'SOURCE.txt'), `${REPOSITORY}\n${COMMIT}\nLocal reference only: no license declared; do not publish.\n`);
  console.log(`apple-hig: ${fs.readdirSync(path.join(target, 'distilled')).length} files at ${COMMIT.slice(0, 12)}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
