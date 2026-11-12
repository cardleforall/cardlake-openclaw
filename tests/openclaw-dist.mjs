// Locates the installed OpenClaw dist/ for contract tests, without spawning
// processes. Set OPENCLAW_DIST to an OpenClaw dist/ directory to choose one
// explicitly. Not a test file itself (no .test suffix).

import fs from 'node:fs';
import path from 'node:path';

function candidates() {
  const list = [process.env.OPENCLAW_DIST];
  for (const node of [process.execPath, safeRealpath(process.execPath)]) {
    if (node) list.push(path.resolve(path.dirname(node), '..', 'lib', 'node_modules', 'openclaw', 'dist'));
  }
  list.push('/usr/lib/node_modules/openclaw/dist', '/usr/local/lib/node_modules/openclaw/dist');
  return [...new Set(list.filter(Boolean))];
}

function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// First dist/ module whose source satisfies `match`, as {file, source}.
export function findDistModule(match) {
  for (const dist of candidates()) {
    if (!fs.existsSync(dist)) continue;
    for (const file of fs.readdirSync(dist).filter(f => f.endsWith('.mjs'))) {
      const source = fs.readFileSync(path.join(dist, file), 'utf8');
      if (match(source)) return {file: path.join(dist, file), source};
    }
  }
  return null;
}
