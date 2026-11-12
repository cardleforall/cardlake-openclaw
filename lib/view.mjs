// Telegram rendering for the /cardlake browser. Card types, labels and urgency
// follow views.py so the plugin and the Python digest look the same.

export const CARD_TYPES = {
  reminder: ['🔔', 'Reminder'],
  learning: ['📚', 'Learning'],
  work: ['💼', 'Work item'],
  family: ['👪', 'Family'],
  bookmark: ['🔖', 'Bookmark'],
  talking_point: ['💬', 'Misc'],
  kanban: ['🗂', 'GitHub issue'],
  file: ['📎', 'File'],
};

export const COMPLETABLE_TYPES = new Set(['reminder', 'learning']);

const MAX_TITLE = 300;
const MAX_EXCERPT = 280;
const DATE_ONLY = /^(\d{4}-\d{2}-\d{2})(?:[T ]00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?)?$/;

export function defaultTimeZone() {
  const tz = process.env.TZ?.trim();
  if (tz) {
    try { new Intl.DateTimeFormat('en', {timeZone: tz}); return tz; } catch { /* fall back */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

// YYYY-MM-DD of `date` in `timeZone`.
function localDay(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(date);
}

function dayDiff(later, earlier) {
  const ms = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  return Math.round((ms(later) - ms(earlier)) / 86400000);
}

// {day, passed} for an unfinished reminder with a due date, else null.
// A date-only (or midnight UTC) due date is a whole day, like views._due_info.
export function dueInfo(card, now, timeZone) {
  const meta = card?.metadata ?? {};
  if (card?.type !== 'reminder' || meta.completed || !meta.due_date) return null;
  const raw = String(meta.due_date).trim();
  const today = localDay(now, timeZone);
  const dateOnly = DATE_ONLY.exec(raw);
  if (dateOnly) return {day: dateOnly[1], passed: dateOnly[1] < today};
  const due = new Date(raw);
  if (Number.isNaN(due.getTime())) return null;
  return {day: localDay(due, timeZone), passed: due < now};
}

export function urgencyLabel(card, now, timeZone) {
  const info = dueInfo(card, now, timeZone);
  if (!info) return '';
  const today = localDay(now, timeZone);
  const late = dayDiff(today, info.day);
  if (info.passed && late > 0) return `⚠️ overdue ${late}d`;
  if (info.passed) return '⚠️ overdue';
  if (info.day === today) return '📅 due today';
  const month = new Date(`${info.day}T12:00:00Z`).toLocaleString('en-GB', {month: 'short', timeZone: 'UTC'});
  return `due ${info.day.slice(8)} ${month}`;
}

// Cardlake considers these cards finished; they leave the feed.
export function isFinished(card) {
  const meta = card?.metadata ?? {};
  if (card?.type === 'reminder') return meta.completed === true;
  if (card?.type === 'learning') return meta.status === 'watched' || meta.status === 'skimmed';
  return false;
}

export function snoozedUntil(card, now) {
  const until = card?.remind_later_until ? new Date(card.remind_later_until) : null;
  return until && !Number.isNaN(until.getTime()) && until > now ? until : null;
}

function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const ZWSP = '​';

// The command reply goes through OpenClaw's Markdown -> Telegram HTML renderer;
// callback edits are sent as plain text and need no escaping. That renderer
// passes Telegram HTML tags through however they are escaped (raw, \<, &lt;,
// &#60;), turns ||x|| into a spoiler, and autolinks URLs, domains and e-mail
// addresses before Markdown escapes apply. Card text comes from Cardlake (and
// GitHub issues synced into it), so neutralise all of that:
// - backslash-escape Markdown punctuation, & (entities), . (domain autolinks)
//   and @ (e-mail autolinks);
// - break "://", "<" and "||" with a zero-width space, never inside a host name
//   (that would create a punycode lookalike link);
// - escape block markers at the start of the text.
// Checked against the real renderer in OpenClaw 2026.11.1 (see README).
export function escapeMarkdown(text) {
  return String(text)
    .replace(/[\\`*_[\]~&.@]/g, '\\$&')
    .replace(/:\/\//g, `:${ZWSP}//`)
    .replace(/</g, `<${ZWSP}`)
    .replace(/\|(?=\|)/g, `|${ZWSP}`)
    .replace(/^(\s*)([#>+=-])/, '$1\\$2')
    .replace(/^(\s*\d+)\)/, '$1\\)');
}

function linkHost(card) {
  const url = String(card?.metadata?.url ?? card?.metadata?.external_url ?? '').trim();
  if (!/^https?:\/\/\S+$/.test(url)) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function formatWhen(date, timeZone) {
  return date.toLocaleString('en-GB', {timeZone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'});
}

// One line describing what happened to the card, from the settled record.
export function statusLine(record, timeZone) {
  if (!record) return '';
  switch (record.status) {
    case 'done': return `✅ ${record.label}`;
    case 'snoozed': return record.until ? `⏰ Snoozed until ${formatWhen(record.until, timeZone)}` : '⏰ Snoozed';
    case 'gone': return '🗑 This card is no longer in Cardlake.';
    case 'uncertain': return '⚠️ Cardlake did not confirm the update. Check the card in Cardlake before trying again.';
    default: return '';
  }
}

// Render the session's current view. Returns {text, buttons}.
export function renderView(session, {now, timeZone, markdown, record, callback}) {
  const esc = markdown ? escapeMarkdown : String;
  const card = session.cards[session.index];
  const heading = session.filter.label ? `🗂 Cardlake · ${session.filter.label}` : '🗂 Cardlake';
  const lines = [heading];

  if (!card) {
    lines.push('', session.filter.label ? `No ${session.filter.label.toLowerCase()} in your feed.` : 'Your Cardlake feed is empty.');
  } else {
    const more = session.nextCursor ? '+' : '';
    lines.push(`Card ${session.index + 1} of ${session.cards.length}${more}${session.page > 0 ? ` · page ${session.page + 1}` : ''}`, '');
    const [emoji, label] = CARD_TYPES[card.type] ?? ['🃏', 'Card'];
    const top = [`${emoji} ${label}`];
    const urgency = urgencyLabel(card, now, timeZone);
    if (urgency) top.push(urgency);
    if (card.pinned_at) top.push('📌');
    lines.push(top.join(' · '));
    lines.push(esc(oneLine(card.title, MAX_TITLE) || 'Untitled'));
    const excerpt = oneLine(card.subtitle || card.body, MAX_EXCERPT);
    if (excerpt) lines.push(esc(excerpt));
    const host = linkHost(card);
    if (host) lines.push(`🔗 ${esc(host)}`);
    const status = statusLine(record, timeZone);
    if (status) lines.push('', esc(status));
  }
  if (session.notice) lines.push('', `ℹ️ ${esc(session.notice)}`);

  const data = op => callback(op);
  const buttons = [];
  if (card && !record) {
    const actions = [];
    if (COMPLETABLE_TYPES.has(card.type) && !isFinished(card)) actions.push({text: '✅ Done', callback_data: data('d')});
    actions.push({text: '⏰ 1 day', callback_data: data('t')}, {text: '📅 7 days', callback_data: data('w')});
    buttons.push(actions);
    buttons.push([{text: card.pinned_at ? '📌 Unpin' : '📌 Pin', callback_data: data('k')}]);
  } else if (card && record?.undo) {
    buttons.push([{text: '↩️ Undo', callback_data: data('u')}]);
  }
  const nav = [];
  if (session.index > 0 || session.page > 0) nav.push({text: '◀ Prev', callback_data: data('p')});
  nav.push({text: '🔄', callback_data: data('r')});
  if (card && (session.index < session.cards.length - 1 || session.nextCursor)) nav.push({text: 'Next ▶', callback_data: data('n')});
  buttons.push(nav);

  return {text: lines.join('\n'), buttons};
}
