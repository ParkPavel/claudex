import { git, ROOT } from '../src/io.mjs';
try { await git(ROOT, ['config', '--local', 'core.hooksPath', '.githooks']); console.log('Claudex Git hooks installed.'); }
catch { console.log('No Git repository yet; run npm run prepare after git init.'); }
