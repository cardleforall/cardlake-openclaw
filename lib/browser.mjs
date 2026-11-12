// /cardlake: browse the Cardlake feed in one Telegram message and act on the
// card being shown. Every view is a session addressed by an unguessable id,
// bound to the configured owner, their private chat and (after the first tap)
// the message carrying it. Buttons carry the view revision, so a tap on an
// outdated keyboard never acts on a different card than the one shown.

import {randomBytes} from 'node:crypto';
import {CardlakeError} from './client.mjs';
import {CARD_TYPES, COMPLETABLE_TYPES, defaultTimeZone, isFinished, renderView, snoozedUntil} from './view.mjs';

export const NAMESPACE = 'cardlake';
export const PAGE_SIZE = 10;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 100;
const SETTLED_TTL_MS = 24 * 60 * 60 * 1000;
const UNCERTAIN_TTL_MS = 10 * 60 * 1000;
const PAYLOAD = /^([A-Za-z0-9_-]{16}):(\d{1,9}):([dtwnpruk])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FILTERS = {
  reminders: {label: 'Reminders', args: {types: ['reminder']}},
  learning: {label: 'Learning', args: {types: ['learning']}},
  work: {label: 'Work items', args: {types: ['work']}},
  family: {label: 'Family', args: {types: ['family']}},
  bookmarks: {label: 'Bookmarks', args: {types: ['bookmark']}},
  misc: {label: 'Misc', args: {types: ['talking_point']}},
  github: {label: 'GitHub issues', args: {types: ['kanban']}},
  files: {label: 'Files', args: {types: ['file']}},
  favorites: {label: 'Favorites', args: {liked_only: true}},
};
const FILTER_ALIASES = {
  reminder: 'reminders', learnings: 'learning', bookmark: 'bookmarks', file: 'files',
  favourites: 'favorites', favorite: 'favorites', favourite: 'favorites',
};

export const USAGE = `Usage: /cardlake [${Object.keys(FILTERS).join('|')}]`;
const DENIED = 'Cardlake is only available to its owner in a private chat with this bot.';
const EXPIRED = 'This Cardlake view has expired. Send /cardlake to browse again.';
const BUTTONS_OFF = 'Cardlake needs inline buttons in private chats, which this bot has turned off. Ask the operator to set channels.telegram.capabilities.inlineButtons to "dm", "all" or "allowlist".';

// OpenClaw silently drops plugin button taps in a DM when the account's
// inline-button scope is "off" or "group", but still delivers the buttons.
// Mirrors resolveTelegramInlineButtonsScope (OpenClaw 2026.11.1): the account's
// capabilities win over the channel's unless empty; a legacy non-empty array
// means "all" if it lists inlineButtons, else "off"; the default is "allowlist".
const INLINE_BUTTON_SCOPES = ['off', 'dm', 'group', 'all', 'allowlist'];
export function inlineButtonsScope(config, accountId) {
  const telegram = config?.channels?.telegram ?? {};
  const account = accountId ? telegram.accounts?.[accountId] : undefined;
  const own = account?.capabilities;
  const caps = own !== undefined && !(Array.isArray(own) && own.length === 0) ? own : telegram.capabilities;
  if (Array.isArray(caps) && caps.length) return caps.some(c => String(c).toLowerCase() === 'inlinebuttons') ? 'all' : 'off';
  const scope = isObject(caps) ? String(caps.inlineButtons ?? '').trim().toLowerCase() : '';
  return INLINE_BUTTON_SCOPES.includes(scope) ? scope : 'allowlist';
}

export function parseFilter(args) {
  const word = String(args ?? '').trim().toLowerCase();
  if (!word) return {label: '', args: {}};
  const filter = FILTERS[FILTER_ALIASES[word] ?? word];
  return filter ?? null;
}

// Arguments after "/cardlake" or "/cardlake@SomeBot".
function commandArgs(ctx) {
  if (typeof ctx.args === 'string') return ctx.args;
  return String(ctx.commandBody ?? '').trim().replace(/^\/\S+\s*/, '');
}

const cardKey = card => `${card.type}:${card.id}`;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validCard = card => isObject(card) && typeof card.id === 'string' && UUID.test(card.id) && Object.hasOwn(CARD_TYPES, card.type);

// Fields whose change would make the shown card misleading to act on.
function materiallyChanged(before, after) {
  const pick = c => JSON.stringify([c.title ?? '', c.metadata?.due_date ?? null, c.metadata?.completed ?? null, c.metadata?.status ?? null]);
  return pick(before) !== pick(after);
}

export function describeError(error) {
  if (!(error instanceof CardlakeError)) return 'Something went wrong talking to Cardlake.';
  switch (error.kind) {
    case 'config': return `Cardlake is not configured: ${error.message}.`;
    case 'auth': return 'Cardlake rejected the API token. Ask the operator to update CARDLAKE_API_TOKEN.';
    case 'network': return 'Could not reach Cardlake. Try again shortly.';
    case 'not_found': return 'That card is no longer in Cardlake.';
    case 'rejected': return `Cardlake refused the request: ${error.message}`;
    default: return 'Cardlake had a problem answering. Try again shortly.';
  }
}

export function createBrowser({
  call,
  allowedUser = process.env.CARDLAKE_TELEGRAM_USER_ID,
  now = Date.now,
  timeZone = defaultTimeZone(),
  logger = null,
} = {}) {
  const owner = /^\d+$/.test(String(allowedUser ?? '').trim()) ? String(allowedUser).trim() : null;
  const sessions = new Map();
  // Outcome per card, shared by every session so two views of the same card
  // can't both act on it.
  const settled = new Map();
  const cardLocks = new Set();

  function prune() {
    const t = now();
    for (const [sid, s] of sessions) if (t - s.touched > SESSION_TTL_MS) sessions.delete(sid);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    for (const [key, record] of settled) if (t > record.expires) settled.delete(key);
  }

  function recordFor(card) {
    if (!card) return null;
    const record = settled.get(cardKey(card));
    if (record && now() > record.expires) { settled.delete(cardKey(card)); return null; }
    return record ?? null;
  }

  function settle(card, status, extra = {}) {
    const ttl = status === 'uncertain' ? UNCERTAIN_TTL_MS : SETTLED_TTL_MS;
    settled.set(cardKey(card), {status, label: '', ...extra, expires: now() + ttl});
  }

  function render(s, markdown) {
    return renderView(s, {
      now: new Date(now()), timeZone, markdown,
      record: recordFor(s.cards[s.index]),
      callback: op => `${NAMESPACE}:${s.sid}:${s.rev}:${op}`,
    });
  }

  async function loadPage(s, cursor) {
    const args = {limit: PAGE_SIZE, sort: 'ai', ...s.filter.args};
    if (cursor) args.cursor = cursor;
    const data = await call('list_feed', args);
    if (!Array.isArray(data.cards)) throw new CardlakeError('protocol', 'list_feed returned no cards', {uncertain: true});
    const seen = new Set();
    const cards = data.cards.filter(c => validCard(c) && !seen.has(cardKey(c)) && seen.add(cardKey(c)));
    const next = typeof data.next_cursor === 'string' && data.next_cursor ? data.next_cursor : null;
    return {cards, next};
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  async function next(s) {
    if (s.index < s.cards.length - 1) { s.index++; return; }
    if (!s.nextCursor) { s.notice = 'That was the last card.'; return; }
    const page = await loadPage(s, s.nextCursor);
    if (!page.cards.length) { s.nextCursor = null; s.notice = 'That was the last card.'; return; }
    s.cursors = [...s.cursors.slice(0, s.page + 1), s.nextCursor];
    s.page++;
    Object.assign(s, {cards: page.cards, nextCursor: page.next, index: 0});
  }

  async function prev(s) {
    if (s.index > 0) { s.index--; return; }
    if (s.page === 0) { s.notice = 'This is the first card.'; return; }
    const page = await loadPage(s, s.cursors[s.page - 1]);
    s.page--;
    Object.assign(s, {cards: page.cards, nextCursor: page.next, index: Math.max(0, page.cards.length - 1)});
  }

  async function refresh(s) {
    const shown = s.cards[s.index];
    const page = await loadPage(s, s.cursors[s.page]);
    const keep = shown ? page.cards.findIndex(c => cardKey(c) === cardKey(shown)) : -1;
    Object.assign(s, {cards: page.cards, nextCursor: page.next, index: keep >= 0 ? keep : Math.min(s.index, Math.max(0, page.cards.length - 1))});
    // Fresh feed data supersedes what we remembered about these cards; the
    // pre-write re-read still blocks acting twice.
    for (const card of page.cards) settled.delete(cardKey(card));
    s.notice = 'Refreshed.';
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async function act(s, op) {
    const shown = s.cards[s.index];
    if (!shown) { s.notice = 'There is no card to update.'; return; }
    const prior = recordFor(shown);
    if (prior) { s.notice = prior.status === 'uncertain' ? 'Check the card in Cardlake before trying again.' : 'This card was already updated.'; return; }
    if (op === 'd' && !COMPLETABLE_TYPES.has(shown.type)) { s.notice = 'Done is only available for reminders and learning.'; return; }
    const key = cardKey(shown);
    if (cardLocks.has(key)) { s.notice = 'Another update to this card is in progress.'; return; }
    cardLocks.add(key);
    try {
      await guardedWrite(s, op, shown);
    } finally {
      cardLocks.delete(key);
    }
  }

  // Reverse a confirmed Done or snooze, then read the card back to confirm.
  async function undo(s) {
    const shown = s.cards[s.index];
    const record = recordFor(shown);
    if (!record?.undo) { s.notice = 'There is nothing to undo.'; return; }
    const key = cardKey(shown);
    if (cardLocks.has(key)) { s.notice = 'Another update to this card is in progress.'; return; }
    cardLocks.add(key);
    try {
      try {
        await call(record.undo.method, record.undo.args);
      } catch (error) {
        if (error instanceof CardlakeError && error.uncertain) { settle(shown, 'uncertain'); return; }
        if (error instanceof CardlakeError && error.kind === 'not_found') { settle(shown, 'gone'); return; }
        s.notice = `${describeError(error)} Nothing was changed.`;
        return;
      }
      let after;
      try {
        after = await readCard(shown);
        // Snoozing unpins a card in Cardlake; pin it again if it was pinned.
        if (record.undo.pinned && !after.pinned_at) {
          await call('pin_card', {card_type: shown.type, card_id: shown.id});
          after = await readCard(shown);
        }
      } catch {
        settle(shown, 'uncertain');
        return;
      }
      if (isFinished(after) || snoozedUntil(after, new Date(now())) || (record.undo.pinned && !after.pinned_at)) { settle(after, 'uncertain'); return; }
      settled.delete(key);
      s.cards[s.index] = after;
      s.notice = 'Undone.';
    } finally {
      cardLocks.delete(key);
    }
  }

  // Pin or unpin the shown card, then read it back to confirm.
  async function togglePin(s) {
    const shown = s.cards[s.index];
    if (!shown || recordFor(shown)) { s.notice = 'There is no card to pin.'; return; }
    const key = cardKey(shown);
    if (cardLocks.has(key)) { s.notice = 'Another update to this card is in progress.'; return; }
    cardLocks.add(key);
    try {
      const pin = !shown.pinned_at;
      try {
        await call(pin ? 'pin_card' : 'unpin_card', {card_type: shown.type, card_id: shown.id});
      } catch (error) {
        if (error instanceof CardlakeError && error.kind === 'not_found') { settle(shown, 'gone'); return; }
        if (!(error instanceof CardlakeError && error.uncertain)) { s.notice = `${describeError(error)} Nothing was changed.`; return; }
      }
      let after;
      try { after = await readCard(shown); } catch { s.notice = 'Cardlake did not confirm the change. Tap 🔄 to check.'; return; }
      s.cards[s.index] = after;
      s.notice = Boolean(after.pinned_at) === pin ? (pin ? 'Pinned.' : 'Unpinned.') : 'Cardlake did not confirm the change. Tap 🔄 to check.';
    } finally {
      cardLocks.delete(key);
    }
  }

  async function readCard(card) {
    const data = await call('get_card', {card_type: card.type, card_id: card.id});
    const current = data.card;
    if (!validCard(current) || cardKey(current) !== cardKey(card))
      throw new CardlakeError('protocol', 'get_card returned a different card', {uncertain: true});
    return current;
  }

  async function guardedWrite(s, op, shown) {
    // 1. Re-read right before writing; never act on a card that has moved on.
    let current;
    try {
      current = await readCard(shown);
    } catch (error) {
      if (error instanceof CardlakeError && error.kind === 'not_found') { settle(shown, 'gone'); return; }
      s.notice = `${describeError(error)} Nothing was changed.`;
      return;
    }
    s.cards[s.index] = current;
    if (isFinished(current)) { settle(current, 'done', {label: 'Already finished in Cardlake'}); return; }
    const until = snoozedUntil(current, new Date(now()));
    if (until) { settle(current, 'snoozed', {until}); return; }
    if (materiallyChanged(shown, current)) { s.notice = 'This card changed since it was shown. Check it and tap again.'; return; }

    // 2. Write. A failure we can't classify might still have been applied.
    const done = op === 'd';
    const method = done ? `update_${current.type}` : 'snooze_card';
    const args = done
      ? {id: current.id, ...(current.type === 'reminder' ? {completed: true} : {status: 'watched'})}
      : {card_type: current.type, card_id: current.id, days: op === 't' ? 1 : 7};
    let result;
    try {
      result = await call(method, args);
    } catch (error) {
      if (error instanceof CardlakeError && error.uncertain) { settle(current, 'uncertain'); return; }
      if (error instanceof CardlakeError && error.kind === 'not_found') { settle(current, 'gone'); return; }
      s.notice = `${describeError(error)} Nothing was changed.`;
      return;
    }

    // 3. Confirm positively before telling the user it worked.
    if (!done) {
      const snoozed = result.card_id === current.id && result.card_type === current.type && result.snoozed_until ? new Date(result.snoozed_until) : null;
      const undo = {method: 'unsnooze_card', args: {card_type: current.type, card_id: current.id}, pinned: Boolean(current.pinned_at)};
      if (snoozed && !Number.isNaN(snoozed.getTime())) settle(current, 'snoozed', {until: snoozed, undo});
      else settle(current, 'uncertain');
      return;
    }
    // update_* has no documented result, so read the card back.
    let after;
    try { after = await readCard(current); } catch { settle(current, 'uncertain'); return; }
    if (isFinished(after)) {
      const undo = current.type === 'reminder'
        ? {method: 'update_reminder', args: {id: current.id, completed: false}, pinned: Boolean(current.pinned_at)}
        : {method: 'update_learning', args: {id: current.id, status: current.metadata?.status || 'saved'}, pinned: Boolean(current.pinned_at)};
      settle(after, 'done', {label: current.type === 'learning' ? 'Marked as watched' : 'Done', undo});
    } else if (current.type === 'reminder' && (after.metadata?.due_date !== current.metadata?.due_date || snoozedUntil(after, new Date(now())))) {
      // Completing a recurring reminder moves it to its next due date. No
      // Undo: restoring the old occurrence isn't something the API offers.
      settle(after, 'done', {label: after.metadata?.due_date ? `Done · next due ${String(after.metadata.due_date).slice(0, 10)}` : 'Done'});
    } else {
      settle(after, 'uncertain');
    }
  }

  // ── Entry points ──────────────────────────────────────────────────────────

  function commandDenial(ctx) {
    if (ctx.channel !== 'telegram' || ctx.isAuthorizedSender !== true) return DENIED;
    if (!owner) return 'Cardlake is not configured: CARDLAKE_TELEGRAM_USER_ID must be the numeric Telegram user ID of the owner.';
    const sender = String(ctx.senderId ?? '');
    // In a private chat the chat id equals the user id; groups use another form.
    if (sender !== owner || String(ctx.from ?? '') !== `telegram:${sender}`) return DENIED;
    return null;
  }

  async function command(ctx) {
    const denied = commandDenial(ctx);
    if (denied) return {text: denied};
    // Without config we can't tell; let the host decide as before.
    const scope = ctx.config ? inlineButtonsScope(ctx.config, ctx.accountId) : 'allowlist';
    if (scope === 'off' || scope === 'group') return {text: BUTTONS_OFF};
    const filter = parseFilter(commandArgs(ctx));
    if (!filter) return {text: USAGE};
    prune();
    const s = {
      sid: randomBytes(12).toString('base64url'),
      sender: String(ctx.senderId), account: String(ctx.accountId ?? 'default'),
      messageId: null, touched: now(), filter,
      cursors: [null], page: 0, cards: [], nextCursor: null, index: 0,
      rev: 1, busy: false, notice: '',
    };
    try {
      const page = await loadPage(s, null);
      Object.assign(s, {cards: page.cards, nextCursor: page.next});
    } catch (error) {
      logger?.warn?.(`cardlake: list_feed failed (${error?.kind ?? 'error'})`);
      return {text: describeError(error)};
    }
    sessions.set(s.sid, s);
    const view = render(s, true);
    return {text: view.text, channelData: {telegram: {buttons: view.buttons}}};
  }

  function callbackAllowed(ctx, s) {
    const sender = String(ctx.senderId ?? '');
    const {chatId, messageId} = ctx.callback ?? {};
    if (ctx.channel !== 'telegram' || ctx.auth?.isAuthorizedSender !== true || ctx.isGroup !== false) return false;
    if (!owner || sender !== owner || String(chatId) !== sender) return false;
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return false;
    if (s && (s.sender !== sender || s.account !== String(ctx.accountId ?? 'default'))) return false;
    if (s && s.messageId !== null && s.messageId !== messageId) return false;
    return true;
  }

  async function show(s, ctx) {
    s.rev++;
    const view = render(s, false);
    s.notice = '';
    try {
      await ctx.respond.editMessage(view);
    } catch (error) {
      // The state change stands; the next tap carries an old revision and
      // re-renders the current view.
      logger?.warn?.(`cardlake: could not edit message: ${error?.message ?? error}`);
    }
  }

  async function callback(ctx) {
    const match = PAYLOAD.exec(String(ctx.callback?.payload ?? ''));
    const s = match ? sessions.get(match[1]) : null;
    if (!callbackAllowed(ctx, s)) {
      await ctx.respond.reply({text: DENIED}).catch(() => {});
      return {handled: true};
    }
    if (!s || now() - s.touched > SESSION_TTL_MS) {
      if (s) sessions.delete(s.sid);
      await ctx.respond.clearButtons().catch(() => {});
      await ctx.respond.reply({text: EXPIRED}).catch(() => {});
      return {handled: true};
    }
    // A second tap while the first is still talking to Cardlake: the first
    // one re-renders when it finishes.
    if (s.busy) return {handled: true};

    s.messageId ??= ctx.callback.messageId;
    s.touched = now();
    sessions.delete(s.sid); // keep the Map in least-recently-used order
    sessions.set(s.sid, s);

    const [, , rev, op] = match;
    if (Number(rev) !== s.rev) {
      s.notice = 'That button was from an older view. This is the current card.';
      await show(s, ctx);
      return {handled: true};
    }

    s.busy = true;
    try {
      if (op === 'n') await next(s);
      else if (op === 'p') await prev(s);
      else if (op === 'r') await refresh(s);
      else if (op === 'u') await undo(s);
      else if (op === 'k') await togglePin(s);
      else await act(s, op);
    } catch (error) {
      logger?.warn?.(`cardlake: ${op} failed (${error?.kind ?? 'error'})`);
      s.notice = describeError(error);
    } finally {
      s.busy = false;
    }
    await show(s, ctx);
    return {handled: true};
  }

  return {command, callback, sessions, settled};
}
