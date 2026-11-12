import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import plugin from '../index.mjs';

test('registers /cardlake and its Telegram callback namespace', () => {
  const commands = [];
  const handlers = [];
  plugin.register({
    logger: {warn() {}},
    registerCommand: def => commands.push(def),
    registerInteractiveHandler: def => handlers.push(def),
  });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'cardlake');
  assert.deepEqual(commands[0].channels, ['telegram']);
  assert.equal(commands[0].requireAuth, true);
  assert.equal(typeof commands[0].handler, 'function');
  assert.deepEqual(handlers.map(h => [h.channel, h.namespace]), [['telegram', 'cardlake']]);
});

test('manifest and package agree on the plugin', () => {
  const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url)));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(manifest.id, plugin.id);
  assert.equal(manifest.activation.onStartup, true);
  assert.deepEqual(pkg.openclaw.extensions, ['./index.mjs']);
});
