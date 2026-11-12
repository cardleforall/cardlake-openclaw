import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createBrowser, inlineButtonsScope, NAMESPACE, USAGE} from '../lib/browser.mjs';
import {CardlakeError} from '../lib/client.mjs';

const OWNER = '4242';
const NOW = Date.parse('2026-11-11T10:00:00Z');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function card(n, type = 'reminder', extra = {}) {
  const metadata = type === 'reminder' ? {completed: false, due_date: '2026-11-10', recurrence: null}
    : type === 'learning' ? {status: 'saved', url: 'https://example.com'} : {};
  return {id: id(n), type, title: `Card ${n}`, subtitle: null, body: null, metadata, created_at: null, pinned_at: null, liked_at: null, remind_later_until: null, ...extra};
}

// Scripted Cardlake: a feed split into pages, a card store, and per-tool overrides.
function fakeCardlake(feed, {pageSize = 10} = {}) {
  const store = new Map(feed.map(c => [c.id, structuredClone(c)]));
  const calls = [];
  const overrides = {};
  async function call(name, args) {
    calls.push([name, args]);
    if (overrides[name]) return overrides[name](args);
    if (name === 'list_feed') {
      const start = args.cursor ? Number(args.cursor) : 0;
      const cards = feed.slice(start, start + pageSize).map(c => structuredClone(store.get(c.id) ?? c));
      return {cards, next_cursor: start + pageSize < feed.length ? String(start + pageSize) : null};
    }
    if (name === 'get_card') {
      const c = store.get(args.card_id);
      if (!c) throw new CardlakeError('not_found', 'Card not found');
      return {card: structuredClone(c)};
    }
    if (name === 'update_reminder') { store.get(args.id).metadata.completed = args.completed; return {id: args.id}; }
    if (name === 'update_learning') { store.get(args.id).metadata.status = args.status; return {id: args.id}; }
    if (name === 'snooze_card') {
      const until = new Date(NOW + args.days * 86400000).toISOString();
      // Cardlake unpins a card when snoozing it.
      Object.assign(store.get(args.card_id), {remind_later_until: until, pinned_at: null});
      return {card_type: args.card_type, card_id: args.card_id, pinned_at: null, liked_at: null, snoozed_until: until};
    }
    if (name === 'unpin_card') { store.get(args.card_id).pinned_at = null; return {card_type: args.card_type, card_id: args.card_id}; }
    if (name === 'pin_card') { store.get(args.card_id).pinned_at = new Date(NOW).toISOString(); return {card_type: args.card_type, card_id: args.card_id}; }
    if (name === 'unsnooze_card') { store.get(args.card_id).remind_later_until = null; return {card_type: args.card_type, card_id: args.card_id}; }
    throw new Error(`unexpected tool ${name}`);
  }
  const writes = () => calls.filter(([name]) => name.startsWith('update_') || name.endsWith('snooze_card'));
  return {call, calls, store, overrides, writes};
}

function setup(feed, opts = {}) {
  const cardlake = fakeCardlake(feed, opts);
  let clock = NOW;
  const browser = createBrowser({call: cardlake.call, allowedUser: OWNER, now: () => clock, timeZone: 'UTC'});
  return {cardlake, browser, advance: ms => { clock += ms; }};
}

const commandCtx = (extra = {}) => ({
  channel: 'telegram', isAuthorizedSender: true, senderId: OWNER, from: `telegram:${OWNER}`,
  accountId: 'default', commandBody: '/cardlake', ...extra,
});

// A Telegram message showing the view, tapped by the owner unless overridden.
function message(reply, messageId = 77) {
  const msg = {text: reply.text, buttons: reply.channelData?.telegram?.buttons ?? [], replies: [], edits: 0, cleared: false};
  msg.button = label => msg.buttons.flat().find(b => b.text.includes(label));
  msg.tap = async (label, ctxExtra = {}, browser) => {
    const button = typeof label === 'string' ? msg.button(label) : label;
    assert.ok(button, `no "${label}" button in ${JSON.stringify(msg.buttons)}`);
    return msg.press(button.callback_data, ctxExtra, browser);
  };
  msg.press = async (data, ctxExtra = {}) => {
    const [namespace, ...rest] = data.split(':');
    assert.equal(namespace, NAMESPACE);
    const ctx = {
      channel: 'telegram', accountId: 'default', senderId: OWNER, isGroup: false, auth: {isAuthorizedSender: true},
      callback: {data, namespace, payload: rest.join(':'), messageId, chatId: OWNER},
      respond: {
        reply: async ({text}) => { msg.replies.push(text); },
        editMessage: async ({text, buttons}) => { msg.edits++; msg.text = text; msg.buttons = buttons ?? []; },
        editButtons: async ({buttons}) => { msg.buttons = buttons; },
        clearButtons: async () => { msg.cleared = true; msg.buttons = []; },
        deleteMessage: async () => {},
      },
      ...ctxExtra,
    };
    if (ctxExtra.callback) ctx.callback = {...ctx.callback, ...ctxExtra.callback};
    return msg.browser.callback(ctx);
  };
  return msg;
}

async function open(env, extra = {}) {
  const reply = await env.browser.command(commandCtx(extra));
  const msg = message(reply);
  msg.browser = env.browser;
  return msg;
}

// ── Command and authorization ───────────────────────────────────────────────

test('/cardlake shows the first card with Done, snooze and navigation buttons', async () => {
  const env = setup([card(1), card(2, 'bookmark')]);
  const msg = await open(env);
  assert.match(msg.text, /Card 1 of 2/);
  assert.match(msg.text, /Card 1\b/);
  assert.deepEqual(msg.buttons.map(r => r.map(b => b.text)), [['✅ Done', '⏰ 1 day', '📅 7 days'], ['📌 Pin'], ['🔄', 'Next ▶']]);
  for (const b of msg.buttons.flat()) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
  assert.deepEqual(env.cardlake.calls, [['list_feed', {limit: 10, sort: 'ai'}]]);
});

test('/cardlake refuses anyone but the owner in a private chat', async () => {
  const env = setup([card(1)]);
  for (const extra of [
    {channel: 'discord'},
    {isAuthorizedSender: false},
    {senderId: '999', from: 'telegram:999'},
    {from: 'telegram:group:-100123'},
    {senderId: undefined},
  ]) {
    const reply = await env.browser.command(commandCtx(extra));
    assert.match(reply.text, /only available to its owner/, JSON.stringify(extra));
    assert.equal(reply.channelData, undefined);
  }
  assert.equal(env.cardlake.calls.length, 0);
});

test('inline-button scope follows OpenClaw resolution', () => {
  const tg = telegram => ({channels: {telegram}});
  assert.equal(inlineButtonsScope({}, 'default'), 'allowlist');
  assert.equal(inlineButtonsScope(tg({capabilities: {inlineButtons: 'OFF '}}), 'default'), 'off');
  assert.equal(inlineButtonsScope(tg({capabilities: {inlineButtons: 'bogus'}}), 'default'), 'allowlist');
  assert.equal(inlineButtonsScope(tg({capabilities: ['inlineButtons']}), 'default'), 'all');
  assert.equal(inlineButtonsScope(tg({capabilities: ['other']}), 'default'), 'off');
  assert.equal(inlineButtonsScope(tg({capabilities: {inlineButtons: 'off'}, accounts: {main: {capabilities: {inlineButtons: 'dm'}}}}), 'main'), 'dm');
  assert.equal(inlineButtonsScope(tg({capabilities: {inlineButtons: 'group'}, accounts: {main: {capabilities: []}}}), 'main'), 'group');
});

test('/cardlake explains instead of sending dead buttons when DM buttons are off', async () => {
  const env = setup([card(1)]);
  for (const inlineButtons of ['off', 'group']) {
    const reply = await env.browser.command(commandCtx({config: {channels: {telegram: {capabilities: {inlineButtons}}}}}));
    assert.match(reply.text, /turned off/);
    assert.equal(reply.channelData, undefined);
  }
  assert.equal(env.cardlake.calls.length, 0);
  for (const inlineButtons of ['dm', 'all', 'allowlist']) {
    const reply = await env.browser.command(commandCtx({config: {channels: {telegram: {capabilities: {inlineButtons}}}}}));
    assert.ok(reply.channelData?.telegram?.buttons?.length, inlineButtons);
  }
});

test('/cardlake explains a missing owner configuration', async () => {
  const browser = createBrowser({call: async () => ({cards: []}), allowedUser: ''});
  assert.match((await browser.command(commandCtx())).text, /CARDLAKE_TELEGRAM_USER_ID/);
});

test('/cardlake filters and usage', async () => {
  const env = setup([card(1)]);
  await env.browser.command(commandCtx({commandBody: '/cardlake@CardBot reminders'}));
  await env.browser.command(commandCtx({commandBody: '/cardlake', args: 'favourites'}));
  assert.deepEqual(env.cardlake.calls.map(([, a]) => a), [
    {limit: 10, sort: 'ai', types: ['reminder']},
    {limit: 10, sort: 'ai', liked_only: true},
  ]);
  assert.equal((await env.browser.command(commandCtx({commandBody: '/cardlake nonsense'}))).text, USAGE);
});

test('/cardlake reports Cardlake failures without exposing details', async () => {
  const env = setup([]);
  env.cardlake.overrides.list_feed = () => { throw new CardlakeError('auth', 'Cardlake rejected the API token'); };
  assert.match((await env.browser.command(commandCtx())).text, /rejected the API token/);
  env.cardlake.overrides.list_feed = () => { throw new CardlakeError('network', 'x', {uncertain: true}); };
  assert.match((await env.browser.command(commandCtx())).text, /Could not reach Cardlake/);
  env.cardlake.overrides.list_feed = () => ({nope: true});
  assert.match((await env.browser.command(commandCtx())).text, /problem answering/);
});

test('/cardlake escapes card text in the Markdown reply', async () => {
  const env = setup([card(1, 'reminder', {title: '[click](https://e.vil) *now*'})]);
  const msg = await open(env);
  assert.ok(msg.text.includes('\\[click\\](https:​//e\\.vil) \\*now\\*'), msg.text);
});

test('/cardlake escapes Cardlake-supplied status text in the Markdown reply', async () => {
  const env = setup([card(1, 'reminder', {metadata: {completed: false, due_date: '2026-11-10', recurrence: 'weekly'}})]);
  env.cardlake.overrides.update_reminder = ({id: cid}) => {
    Object.assign(env.cardlake.store.get(cid), {metadata: {completed: false, due_date: '<b>x</b>', recurrence: 'weekly'}, remind_later_until: '2026-11-17T00:00:00Z'});
    return {};
  };
  const first = await open(env);
  await first.tap('Done');
  // A second /cardlake renders the settled card (with its status) as Markdown.
  const second = await open(env);
  assert.ok(second.text.includes('<​b>x<​/b>'), second.text);
});

test('an empty feed has only a refresh button', async () => {
  const env = setup([]);
  const msg = await open(env);
  assert.match(msg.text, /feed is empty/);
  assert.deepEqual(msg.buttons.map(r => r.map(b => b.text)), [['🔄']]);
});

test('taps from anyone or anywhere else are refused without touching Cardlake', async () => {
  const env = setup([card(1)]);
  const msg = await open(env);
  const before = env.cardlake.calls.length;
  const done = msg.button('Done').callback_data;
  for (const extra of [
    {senderId: '999'},
    {auth: {isAuthorizedSender: false}},
    {isGroup: true},
    {channel: 'slack'},
    {accountId: 'other'},
    {callback: {chatId: '-100123'}},
    {callback: {messageId: 0}},
  ]) {
    await msg.press(done, extra);
    assert.match(msg.replies.at(-1), /only available to its owner/, JSON.stringify(extra));
  }
  assert.equal(env.cardlake.calls.length, before);
  assert.equal(msg.edits, 0);
});

test('a view is bound to the first message that uses it', async () => {
  const env = setup([card(1), card(2)]);
  const msg = await open(env);
  await msg.tap('Next');
  await msg.press(msg.button('Prev').callback_data, {callback: {messageId: 78}});
  assert.match(msg.replies.at(-1), /only available to its owner/);
  assert.match(msg.text, /Card 2 of 2/);
});

test('forged or unknown callback payloads are refused or expire', async () => {
  const env = setup([card(1)]);
  const msg = await open(env);
  await msg.press(`${NAMESPACE}:garbage`, {senderId: '999'});
  assert.match(msg.replies.at(-1), /only available to its owner/);
  await msg.press(`${NAMESPACE}:garbage`);
  assert.match(msg.replies.at(-1), /expired/);
  await msg.press(`${NAMESPACE}:AAAAAAAAAAAAAAAA:2:d`);
  assert.match(msg.replies.at(-1), /expired/);
  assert.equal(msg.cleared, true);
  assert.equal(env.cardlake.writes().length, 0);
});

test('views expire after a day', async () => {
  const env = setup([card(1)]);
  const msg = await open(env);
  env.advance(25 * 60 * 60 * 1000);
  await msg.tap('Done');
  assert.match(msg.replies.at(-1), /expired/);
  assert.equal(env.cardlake.writes().length, 0);
});

// ── Browsing ────────────────────────────────────────────────────────────────

test('Next and Prev browse within and across feed pages', async () => {
  const env = setup([card(1), card(2), card(3)], {pageSize: 2});
  const msg = await open(env);
  await msg.tap('Next');
  assert.match(msg.text, /Card 2 of 2\+/);
  await msg.tap('Next');
  assert.match(msg.text, /Card 1 of 1 · page 2\n\n.*\nCard 3/);
  assert.equal(msg.button('Next'), undefined);
  await msg.tap('Prev');
  assert.match(msg.text, /Card 2 of 2\+\n\n.*\nCard 2/);
  await msg.tap('Prev');
  await msg.tap('🔄');
  assert.match(msg.text, /Card 1 of 2\+[\s\S]*Refreshed/);
  const cursors = env.cardlake.calls.filter(([n]) => n === 'list_feed').map(([, a]) => a.cursor ?? null);
  assert.deepEqual(cursors, [null, '2', null, null]);
});

test('a tap on an outdated keyboard re-renders instead of acting', async () => {
  const env = setup([card(1), card(2)]);
  const msg = await open(env);
  const staleDone = msg.button('Done').callback_data; // for card 1
  await msg.tap('Next'); // now showing card 2
  await msg.press(staleDone);
  assert.match(msg.text, /older view/);
  assert.match(msg.text, /Card 2 of 2/);
  assert.equal(env.cardlake.writes().length, 0);
});

test('navigation failures leave the view in place', async () => {
  const env = setup([card(1), card(2)], {pageSize: 1});
  const msg = await open(env);
  env.cardlake.overrides.list_feed = () => { throw new CardlakeError('network', 'x', {uncertain: true}); };
  await msg.tap('Next');
  assert.match(msg.text, /Card 1 of 1\+[\s\S]*Could not reach Cardlake/);
});

// ── Done and snooze ─────────────────────────────────────────────────────────

test('Done completes a reminder after re-reading it, then confirms', async () => {
  const env = setup([card(1)]);
  const msg = await open(env);
  await msg.tap('Done');
  assert.deepEqual(env.cardlake.calls.slice(1).map(([n]) => n), ['get_card', 'update_reminder', 'get_card']);
  assert.deepEqual(env.cardlake.writes()[0][1], {id: id(1), completed: true});
  assert.match(msg.text, /✅ Done/);
  assert.equal(msg.button('Done'), undefined);
  assert.equal(msg.button('1 day'), undefined);
});

test('Done marks a learning as watched', async () => {
  const env = setup([card(1, 'learning')]);
  const msg = await open(env);
  await msg.tap('Done');
  assert.deepEqual(env.cardlake.writes()[0], ['update_learning', {id: id(1), status: 'watched'}]);
  assert.match(msg.text, /Marked as watched/);
});

test('Done on a recurring reminder reports the next due date', async () => {
  const env = setup([card(1, 'reminder', {metadata: {completed: false, due_date: '2026-11-10', recurrence: 'weekly'}})]);
  env.cardlake.overrides.update_reminder = ({id: cid}) => {
    Object.assign(env.cardlake.store.get(cid), {metadata: {completed: false, due_date: '2026-11-17', recurrence: 'weekly'}, remind_later_until: '2026-11-17T00:00:00Z'});
    return {};
  };
  const msg = await open(env);
  await msg.tap('Done');
  assert.match(msg.text, /Done · next due 2026-11-17/);
});

test('snooze buttons pass 1 or 7 days and show the confirmed time', async () => {
  for (const [label, days, shown] of [['1 day', 1, '12 Nov'], ['7 days', 7, '18 Nov']]) {
    const env = setup([card(1, 'bookmark')]);
    const msg = await open(env);
    await msg.tap(label);
    assert.deepEqual(env.cardlake.writes(), [['snooze_card', {card_type: 'bookmark', card_id: id(1), days}]]);
    assert.match(msg.text, new RegExp(`Snoozed until ${shown}`));
  }
});

test('a snooze response that does not confirm the card is reported as unconfirmed', async () => {
  const env = setup([card(1)]);
  env.cardlake.overrides.snooze_card = () => ({card_id: id(2), card_type: 'reminder', snoozed_until: '2026-11-12T00:00:00Z'});
  const msg = await open(env);
  await msg.tap('1 day');
  assert.match(msg.text, /did not confirm/);
});

test('an unconfirmed Done is not claimed as success', async () => {
  const env = setup([card(1)]);
  env.cardlake.overrides.update_reminder = () => ({});
  const msg = await open(env);
  await msg.tap('Done');
  assert.match(msg.text, /did not confirm/);
});

test('a write that may have been applied blocks retries instead of repeating it', async () => {
  const env = setup([card(1)]);
  env.cardlake.overrides.update_reminder = () => { throw new CardlakeError('network', 'x', {uncertain: true}); };
  const msg = await open(env);
  await msg.tap('Done');
  assert.match(msg.text, /did not confirm/);
  assert.equal(msg.button('Done'), undefined);
  // Another view of the same card is blocked too.
  const other = await open(env);
  assert.equal(other.button('Done'), undefined);
  assert.equal(env.cardlake.writes().length, 1);
});

test('a rejected write changes nothing and can be retried', async () => {
  const env = setup([card(1)]);
  env.cardlake.overrides.update_reminder = () => { throw new CardlakeError('rejected', 'Invalid UUID'); };
  const msg = await open(env);
  await msg.tap('Done');
  assert.match(msg.text, /refused the request: Invalid UUID Nothing was changed/);
  delete env.cardlake.overrides.update_reminder;
  await msg.tap('Done');
  assert.match(msg.text, /✅ Done/);
});

test('an auth failure during the pre-read writes nothing', async () => {
  const env = setup([card(1)]);
  env.cardlake.overrides.get_card = () => { throw new CardlakeError('auth', 'x'); };
  const msg = await open(env);
  await msg.tap('Done');
  assert.match(msg.text, /rejected the API token[\s\S]*Nothing was changed/);
  assert.equal(env.cardlake.writes().length, 0);
});

test('a deleted card is reported and not written', async () => {
  const env = setup([card(1)]);
  const msg = await open(env);
  env.cardlake.store.delete(id(1));
  await msg.tap('Done');
  assert.match(msg.text, /no longer in Cardlake/);
  assert.equal(env.cardlake.writes().length, 0);
});

test('a card finished or snoozed elsewhere is not written again', async () => {
  const env = setup([card(1), card(2)]);
  const msg = await open(env);
  env.cardlake.store.get(id(1)).metadata.completed = true;
  await msg.tap('1 day');
  assert.match(msg.text, /Already finished in Cardlake/);
  await msg.tap('Next');
  env.cardlake.store.get(id(2)).remind_later_until = '2026-11-20T08:00:00Z';
  await msg.tap('Done');
  assert.match(msg.text, /Snoozed until 20 Nov/);
  assert.equal(env.cardlake.writes().length, 0);
});

test('a card edited since it was shown must be checked before acting', async () => {
  const env = setup([card(1)]);
  const msg = await open(env);
  env.cardlake.store.get(id(1)).title = 'Renamed';
  await msg.tap('Done');
  assert.match(msg.text, /Renamed[\s\S]*changed since it was shown/);
  assert.equal(env.cardlake.writes().length, 0);
  await msg.tap('Done');
  assert.match(msg.text, /✅ Done/);
});

test('a second view of an updated card does not act twice', async () => {
  const env = setup([card(1)]);
  const first = await open(env);
  const second = await open(env);
  await first.tap('Done');
  await second.tap('7 days');
  assert.match(second.text, /already updated/);
  assert.equal(env.cardlake.writes().length, 1);
});

test('double taps and concurrent views of one card write once', async () => {
  const env = setup([card(1)]);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  env.cardlake.overrides.update_reminder = async args => { await gate; env.cardlake.store.get(args.id).metadata.completed = true; return {}; };
  const first = await open(env);
  const second = await open(env);
  const done = first.button('Done').callback_data;
  const pending = first.press(done);
  await new Promise(r => setImmediate(r));
  await first.press(done); // same message, still busy: ignored
  const other = second.tap('Done'); // other view, card locked
  await new Promise(r => setImmediate(r));
  release();
  await Promise.all([pending, other]);
  assert.match(second.text, /in progress/);
  assert.match(first.text, /✅ Done/);
  assert.equal(env.cardlake.writes().length, 1);
});

test('a failed message edit does not undo or repeat the action', async () => {
  const env = setup([card(1)]);
  const msg = await open(env);
  const done = msg.button('Done').callback_data;
  const failingEdit = {respond: {reply: async () => {}, editMessage: async () => { throw new Error('Bad Request'); }, clearButtons: async () => {}}};
  await msg.press(done, failingEdit);
  await msg.press(done); // old keyboard still visible: re-renders the outcome
  assert.match(msg.text, /✅ Done[\s\S]*older view/);
  assert.equal(env.cardlake.writes().length, 1);
});

test('Refresh clears remembered outcomes for cards that are back in the feed', async () => {
  const env = setup([card(1)]);
  env.cardlake.overrides.update_reminder = () => { throw new CardlakeError('network', 'x', {uncertain: true}); };
  const msg = await open(env);
  await msg.tap('Done');
  delete env.cardlake.overrides.update_reminder;
  await msg.tap('🔄');
  assert.ok(msg.button('Done'));
  await msg.tap('Done');
  assert.match(msg.text, /✅ Done/);
  assert.equal(env.cardlake.writes().length, 2);
});

// ── Undo ────────────────────────────────────────────────────────────────────

test('Undo reopens a completed reminder and brings its buttons back', async () => {
  const env = setup([card(1)]);
  const msg = await open(env);
  await msg.tap('Done');
  assert.deepEqual(msg.buttons.map(r => r.map(b => b.text)), [['↩️ Undo'], ['🔄']]);
  await msg.tap('Undo');
  assert.deepEqual(env.cardlake.writes().map(w => w[1]), [{id: id(1), completed: true}, {id: id(1), completed: false}]);
  assert.equal(env.cardlake.store.get(id(1)).metadata.completed, false);
  assert.match(msg.text, /Undone\./);
  assert.doesNotMatch(msg.text, /✅ Done/);
  assert.ok(msg.button('Done'));
});

test('Undo restores a learning to its previous status', async () => {
  const env = setup([card(1, 'learning', {metadata: {status: 'in_progress', url: 'https://example.com'}})]);
  const msg = await open(env);
  await msg.tap('Done');
  await msg.tap('Undo');
  assert.deepEqual(env.cardlake.writes()[1], ['update_learning', {id: id(1), status: 'in_progress'}]);
  assert.ok(msg.button('Done'));
});

test('Undo unsnoozes a snoozed card', async () => {
  const env = setup([card(1, 'bookmark')]);
  const msg = await open(env);
  await msg.tap('7 days');
  await msg.tap('Undo');
  assert.deepEqual(env.cardlake.writes()[1], ['unsnooze_card', {card_type: 'bookmark', card_id: id(1)}]);
  assert.equal(env.cardlake.store.get(id(1)).remind_later_until, null);
  assert.match(msg.text, /Undone\./);
  assert.ok(msg.button('1 day'));
});

test('an Undo that Cardlake does not confirm is not claimed as success', async () => {
  const env = setup([card(1, 'bookmark')]);
  env.cardlake.overrides.unsnooze_card = () => ({});
  const msg = await open(env);
  await msg.tap('1 day');
  await msg.tap('Undo');
  assert.match(msg.text, /did not confirm/);
  assert.equal(msg.button('Undo'), undefined);
});

test('a rejected Undo keeps the outcome and can be retried', async () => {
  const env = setup([card(1)]);
  const msg = await open(env);
  await msg.tap('Done');
  env.cardlake.overrides.update_reminder = () => { throw new CardlakeError('rejected', 'nope'); };
  await msg.tap('Undo');
  assert.match(msg.text, /✅ Done[\s\S]*Nothing was changed/);
  delete env.cardlake.overrides.update_reminder;
  await msg.tap('Undo');
  assert.match(msg.text, /Undone\./);
});

test('recurring reminders and unconfirmed writes offer no Undo', async () => {
  const env = setup([card(1, 'reminder', {metadata: {completed: false, due_date: '2026-11-10', recurrence: 'weekly'}})]);
  env.cardlake.overrides.update_reminder = ({id: cid}) => {
    Object.assign(env.cardlake.store.get(cid), {metadata: {completed: false, due_date: '2026-11-17', recurrence: 'weekly'}});
    return {};
  };
  const msg = await open(env);
  await msg.tap('Done');
  assert.match(msg.text, /next due/);
  assert.equal(msg.button('Undo'), undefined);
});

test('a stale Undo payload does nothing when there is nothing to undo', async () => {
  const env = setup([card(1)]);
  const msg = await open(env);
  await msg.tap('Done');
  const undo = msg.button('Undo').callback_data;
  await msg.tap('Undo');
  const writes = env.cardlake.writes().length;
  await msg.press(undo);
  assert.equal(env.cardlake.writes().length, writes);
});

test('Undo pins a snoozed card again if it was pinned', async () => {
  const env = setup([card(1, 'work', {pinned_at: '2026-11-01T00:00:00Z'})]);
  const msg = await open(env);
  await msg.tap('1 day');
  await msg.tap('Undo');
  assert.deepEqual(env.cardlake.calls.slice(-4).map(([n]) => n), ['unsnooze_card', 'get_card', 'pin_card', 'get_card']);
  assert.ok(env.cardlake.store.get(id(1)).pinned_at);
  assert.match(msg.text, /📌[\s\S]*Undone\./);
});

test('Undo does not pin a card that was not pinned', async () => {
  const env = setup([card(1, 'bookmark')]);
  const msg = await open(env);
  await msg.tap('1 day');
  await msg.tap('Undo');
  assert.equal(env.cardlake.calls.some(([n]) => n === 'pin_card'), false);
});

test('Pin and Unpin toggle the pin and confirm it', async () => {
  const env = setup([card(1, 'bookmark')]);
  const msg = await open(env);
  await msg.tap('📌 Pin');
  assert.deepEqual(env.cardlake.calls.slice(-2).map(([n]) => n), ['pin_card', 'get_card']);
  assert.match(msg.text, /📌[\s\S]*Pinned\./);
  await msg.tap('📌 Unpin');
  assert.equal(env.cardlake.store.get(id(1)).pinned_at, null);
  assert.match(msg.text, /Unpinned\./);
  assert.ok(msg.button('📌 Pin'));
});

test('a pin that Cardlake does not confirm is reported', async () => {
  const env = setup([card(1, 'bookmark')]);
  env.cardlake.overrides.pin_card = () => ({});
  const msg = await open(env);
  await msg.tap('📌 Pin');
  assert.match(msg.text, /did not confirm/);
});

test('a refused pin changes nothing', async () => {
  const env = setup([card(1, 'bookmark', {pinned_at: '2026-11-01T00:00:00Z'})]);
  env.cardlake.overrides.unpin_card = () => { throw new CardlakeError('rejected', 'Unknown tool'); };
  const msg = await open(env);
  await msg.tap('📌 Unpin');
  assert.match(msg.text, /Nothing was changed/);
  assert.deepEqual(env.cardlake.calls.slice(-1).map(([n]) => n), ['unpin_card']);
});
