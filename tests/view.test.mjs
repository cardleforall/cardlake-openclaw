import assert from 'node:assert/strict';
import {test} from 'node:test';
import {escapeMarkdown, isFinished, renderView, snoozedUntil, urgencyLabel} from '../lib/view.mjs';

const NOW = new Date('2026-11-11T10:00:00Z');
const TZ = 'Europe/Oslo';
const reminder = due => ({type: 'reminder', metadata: {completed: false, due_date: due}});

test('urgency follows views.py', () => {
  assert.equal(urgencyLabel(reminder('2026-11-09'), NOW, TZ), '⚠️ overdue 2d');
  assert.equal(urgencyLabel(reminder('2026-11-11'), NOW, TZ), '📅 due today');
  assert.equal(urgencyLabel(reminder('2026-11-11T00:00:00Z'), NOW, TZ), '📅 due today');
  assert.equal(urgencyLabel(reminder('2026-11-11T09:00:00+01:00'), NOW, TZ), '⚠️ overdue');
  assert.equal(urgencyLabel(reminder('2026-11-20'), NOW, TZ), 'due 20 Nov');
  assert.equal(urgencyLabel({...reminder('2026-11-01'), metadata: {completed: true, due_date: '2026-11-01'}}, NOW, TZ), '');
  assert.equal(urgencyLabel(reminder('garbage'), NOW, TZ), '');
  assert.equal(urgencyLabel({type: 'learning', metadata: {}}, NOW, TZ), '');
});

test('finished and snoozed state', () => {
  assert.equal(isFinished({type: 'reminder', metadata: {completed: true}}), true);
  assert.equal(isFinished({type: 'learning', metadata: {status: 'watched'}}), true);
  assert.equal(isFinished({type: 'learning', metadata: {status: 'saved'}}), false);
  assert.ok(snoozedUntil({remind_later_until: '2026-11-12T00:00:00Z'}, NOW));
  assert.equal(snoozedUntil({remind_later_until: '2026-11-01T00:00:00Z'}, NOW), null);
  assert.equal(snoozedUntil({remind_later_until: null}, NOW), null);
});

test('markdown escaping neutralises formatting, HTML, spoilers and autolinks', () => {
  const Z = '​';
  assert.equal(escapeMarkdown('*hi* [x](https://e.vil) _a_ `c` ~s~'), `\\*hi\\* \\[x\\](https:${Z}//e\\.vil) \\_a\\_ \\\`c\\\` \\~s\\~`);
  assert.equal(escapeMarkdown('<a href="u">t</a> &lt;b&gt;'), `<${Z}a href="u">t<${Z}/a> \\&lt;b\\&gt;`);
  assert.equal(escapeMarkdown('||spoiler|| a|b'), `|${Z}|spoiler|${Z}| a|b`);
  assert.equal(escapeMarkdown('me@example.com'), 'me\\@example\\.com');
  assert.equal(escapeMarkdown('# h'), '\\# h');
  assert.equal(escapeMarkdown('> q'), '\\> q');
  assert.equal(escapeMarkdown('- i'), '\\- i');
  assert.equal(escapeMarkdown('1) i'), '1\\) i');
  assert.equal(escapeMarkdown('1. i'), '1\\. i');
  // Never put the zero-width space inside a host name (punycode lookalikes).
  assert.ok(!/[a-z0-9]​[a-z0-9.]/i.test(escapeMarkdown('https://www.example.com/x www.example.com')));
});

function session(cards, extra = {}) {
  return {filter: {label: '', args: {}}, cards, index: 0, page: 0, nextCursor: null, notice: '', ...extra};
}

const view = (s, extra = {}) => renderView(s, {now: NOW, timeZone: TZ, markdown: false, record: null, callback: op => `cb:${op}`, ...extra});

test('renders the current card with action and navigation buttons', () => {
  const cards = [
    {id: 'a', type: 'reminder', title: 'Pay *rent*', metadata: {completed: false, due_date: '2026-11-10'}, pinned_at: 'x'},
    {id: 'b', type: 'bookmark', title: 'Read', metadata: {url: 'https://www.example.com/x'}},
  ];
  const first = view(session(cards));
  assert.match(first.text, /Card 1 of 2/);
  assert.match(first.text, /🔔 Reminder · ⚠️ overdue 1d · 📌/);
  assert.match(first.text, /Pay \*rent\*/);
  assert.deepEqual(first.buttons.map(r => r.map(b => b.callback_data)), [['cb:d', 'cb:t', 'cb:w'], ['cb:k'], ['cb:r', 'cb:n']]);

  const second = view(session(cards, {index: 1, nextCursor: 'c'}), {markdown: true});
  assert.match(second.text, /Card 2 of 2\+/);
  assert.match(second.text, /🔗 example\\\.com/);
  // Bookmarks can't be completed; more pages exist so Next stays.
  assert.deepEqual(second.buttons.map(r => r.map(b => b.callback_data)), [['cb:t', 'cb:w'], ['cb:k'], ['cb:p', 'cb:r', 'cb:n']]);
});

test('a settled card shows its outcome and no action buttons', () => {
  const s = session([{id: 'a', type: 'learning', title: 'Talk', metadata: {status: 'saved'}}]);
  const v = view(s, {record: {status: 'done', label: 'Marked as watched'}});
  assert.match(v.text, /✅ Marked as watched/);
  assert.deepEqual(v.buttons.map(r => r.map(b => b.callback_data)), [['cb:r']]);
  assert.match(view(s, {record: {status: 'uncertain'}}).text, /did not confirm/);
});

test('empty feed and filtered views', () => {
  assert.match(view(session([])).text, /feed is empty/);
  assert.match(view(session([], {filter: {label: 'Reminders', args: {}}})).text, /Cardlake · Reminders\n\nNo reminders/);
});
