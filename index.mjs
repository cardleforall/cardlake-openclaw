// OpenClaw plugin entry: registers /cardlake for Telegram and the callback
// namespace its buttons use. See README.md for setup.
//
// Same shape definePluginEntry() returns. The helper itself isn't imported:
// openclaw/plugin-sdk only resolves inside OpenClaw's loader, and the tests
// load this file with plain Node.

import {createBrowser, NAMESPACE} from './lib/browser.mjs';
import {createClient} from './lib/client.mjs';

export default {
  id: 'cardlake',
  name: 'Cardlake',
  description: 'Browse your Cardlake feed in Telegram with /cardlake',
  register(api) {
    const client = createClient();
    if (client.configError) api.logger?.warn?.(`cardlake: ${client.configError}`);
    const browser = createBrowser({call: client.call, logger: api.logger});
    api.registerCommand({
      name: 'cardlake',
      description: 'Browse your Cardlake feed',
      channels: ['telegram'],
      acceptsArgs: true,
      requireAuth: true,
      handler: browser.command,
    });
    api.registerInteractiveHandler({channel: 'telegram', namespace: NAMESPACE, handler: browser.callback});
  },
};
