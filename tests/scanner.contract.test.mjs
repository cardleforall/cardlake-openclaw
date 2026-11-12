// Contract test against the code-safety scanner of the OpenClaw installed on
// this machine: the scanner `openclaw security audit --deep` runs over every
// file of an installed plugin (tests included) and SKILL.md. Any critical or
// warn finding is reported against the plugin. Skipped (not passed) when
// OpenClaw can't be found; see openclaw-dist.mjs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {findDistModule} from './openclaw-dist.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Bundled dist/ files export minified names: `export { scanSource as i, ... }`.
const alias = (source, name) => new RegExp(`\\b${name} as ([\\w$]+)`).exec(source)?.[1];

const found = findDistModule(source =>
  source.includes('function scanDirectoryWithSummary(') &&
  ['scanDirectoryWithSummary', 'scanSkillContent', 'scanSource'].every(name => alias(source, name)));
const skip = found ? false : 'OpenClaw dist not found (set OPENCLAW_DIST)';

const reportable = findings => findings
  .filter(f => f.severity === 'critical' || f.severity === 'warn')
  .map(f => `${f.severity} ${f.ruleId} ${path.relative(ROOT, f.file) || f.file}:${f.line} ${f.evidence}`);

test('plugin code passes the installed OpenClaw code-safety scan', {skip}, async () => {
  const scanner = await import(found.file);
  const scan = scanner[alias(found.source, 'scanDirectoryWithSummary')];
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const summary = await scan(ROOT, {includeFiles: pkg.openclaw.extensions});
  assert.ok(summary.scannedFiles > 0);
  assert.equal(summary.truncated, false);
  assert.deepEqual(reportable(summary.findings), []);
});

test('SKILL.md passes the installed OpenClaw skill-content scan', {skip}, async () => {
  const scanner = await import(found.file);
  const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  const findings = [
    ...scanner[alias(found.source, 'scanSkillContent')](content, 'SKILL.md'),
    ...scanner[alias(found.source, 'scanSource')](content, 'SKILL.md'),
  ];
  assert.deepEqual(reportable(findings), []);
});
