import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CardlakeError, createClient, mcpEndpoint} from '../lib/client.mjs';

function jsonResponse(body, {status = 200, type = 'application/json'} = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: {get: name => (name.toLowerCase() === 'content-type' ? type : null)},
    json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function client(respond, opts = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({url, init, body});
    return respond(body);
  };
  return {requests, ...createClient({token: 'secret-token', base: 'https://cardlake.test', fetchImpl, ...opts})};
}

const ok = (id, result) => jsonResponse({jsonrpc: '2.0', id, result});

async function rejectsWith(promise, kind, uncertain) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof CardlakeError, `expected CardlakeError, got ${error}`);
    assert.equal(error.kind, kind);
    assert.equal(error.uncertain, uncertain);
    assert.ok(!error.message.includes('secret-token'));
    return true;
  });
}

test('sends an authenticated tools/call and prefers structuredContent', async () => {
  const c = client(body => ok(body.id, {structuredContent: {cards: [1]}, content: [{type: 'text', text: '{"cards":[2]}'}]}));
  assert.deepEqual(await c.call('list_feed', {limit: 1}), {cards: [1]});
  const [{url, init, body}] = c.requests;
  assert.equal(url, 'https://cardlake.test/api/mcp');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer secret-token');
  assert.deepEqual(body.params, {name: 'list_feed', arguments: {limit: 1}});
});

test('falls back to JSON text content', async () => {
  const c = client(body => ok(body.id, {content: [{type: 'text', text: '{"card":{"id":"x"}}'}]}));
  assert.deepEqual(await c.call('get_card'), {card: {id: 'x'}});
});

test('reads a single matching message from an event stream', async () => {
  const c = client(body => jsonResponse(
    `event: message\ndata: {"jsonrpc":"2.0","id":${body.id},"result":{"structuredContent":{"ok":true}}}\n\n`,
    {type: 'text/event-stream'}));
  assert.deepEqual(await c.call('x'), {ok: true});
});

test('tool errors are failures, not results', async () => {
  const notFound = client(body => ok(body.id, {isError: true, content: [{type: 'text', text: 'Error: Card not found'}]}));
  await rejectsWith(notFound.call('get_card'), 'not_found', false);
  const invalid = client(body => ok(body.id, {isError: true, content: [{type: 'text', text: 'MCP error -32602: Invalid UUID'}]}));
  await rejectsWith(invalid.call('get_card'), 'rejected', false);
});

test('classifies HTTP and transport failures', async () => {
  await rejectsWith(client(() => jsonResponse({}, {status: 401})).call('x'), 'auth', false);
  await rejectsWith(client(() => jsonResponse({}, {status: 403})).call('x'), 'auth', false);
  await rejectsWith(client(() => jsonResponse({}, {status: 400})).call('x'), 'rejected', false);
  await rejectsWith(client(() => jsonResponse({}, {status: 502})).call('x'), 'server', true);
  await rejectsWith(client(() => { throw new Error('timeout'); }).call('x'), 'network', true);
  await rejectsWith(client(() => jsonResponse('not json', {type: 'text/plain'})).call('x'), 'protocol', true);
  await rejectsWith(client(() => ok(999, {structuredContent: {}})).call('x'), 'protocol', true);
  await rejectsWith(client(body => jsonResponse({jsonrpc: '2.0', id: body.id, error: {message: 'bad'}})).call('x'), 'rejected', false);
});

test('refuses to run without a token or with an unsafe endpoint', async () => {
  for (const opts of [{token: ''}, {base: 'http://cardlake.test'}, {base: 'https://u:p@cardlake.test'}, {base: 'https://cardlake.test/?x=1'}, {base: 'nope'}]) {
    let fetched = false;
    const c = createClient({token: 'secret-token', base: 'https://cardlake.test', fetchImpl: () => { fetched = true; }, ...opts});
    assert.ok(c.configError);
    await rejectsWith(c.call('x'), 'config', false);
    assert.equal(fetched, false);
  }
});

test('builds the MCP endpoint from a base URL', () => {
  assert.equal(mcpEndpoint('https://cardlake.app'), 'https://cardlake.app/api/mcp');
  assert.equal(mcpEndpoint('https://example.com/cardlake/'), 'https://example.com/cardlake/api/mcp');
  assert.equal(mcpEndpoint('http://localhost:3000'), 'http://localhost:3000/api/mcp');
});
