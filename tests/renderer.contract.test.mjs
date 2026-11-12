// Contract test against the Markdown -> Telegram HTML renderer of the OpenClaw
// installed on this machine: the renderer /cardlake replies actually go
// through. Skipped (not passed) when OpenClaw can't be found. Set OPENCLAW_DIST
// to an OpenClaw dist/ directory to choose one explicitly.

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {escapeMarkdown, renderView} from '../lib/view.mjs';
import {findDistModule} from './openclaw-dist.mjs';

function findRenderer() {
  const mod = findDistModule(source =>
    source.includes('function planTelegramTextDeliveryPages(') && /planTelegramTextDeliveryPages as ([\w$]+)/.test(source));
  if (!mod) return null;
  return {file: mod.file, alias: /planTelegramTextDeliveryPages as ([\w$]+)/.exec(mod.source)[1]};
}

const found = findRenderer();
const skip = found ? false : 'OpenClaw dist not found (set OPENCLAW_DIST)';

const CORPUS = [
  'Pay *rent* [now](https://e.vil/x) _soon_ <b>x</b> & co',
  '<a href="https://evil.example/pay">Pay invoice</a>', '<i>it</i> <u>u</u> <s>s</s> <code>c</code> <pre>p</pre>',
  '<tg-spoiler>s</tg-spoiler> <blockquote>q</blockquote>', '<b >x</b > <B>x</B> <script>alert(1)</script>',
  '&lt;b&gt;x&lt;/b&gt; &amp; &#60;b&#62; &quot;', '&lt;a href="x"&gt;y&lt;/a&gt;', 'Fix ||secret|| leak',
  '**bold** __under__ ~~strike~~ ***both*** `code` ``two``', '[x](javascript:alert(1)) ![img](https://e.vil/i.png) <https://auto.link>',
  '[ref][1]', '[1]: https://e.vil', 'https://example.com/a_b*c_(d).html?q=1&r=2', 'https://x.y/[a](https://e.vil)',
  'xhttps://a.b/_c_', 'a_https://x.y/_b_', '[https://x.y/](https://e.vil)', 'www.example.com and me@example.com',
  'www.x_y.com/_a_', 'example.com/a_b', 'a_b@x_y.com', 'http://localhost:3000/_a_', 'v1.2.3 README.md __init__.py',
  '# heading', '> quote', '- item', '+ item', '* item', '1. one', '2) two', '---', '| a | b |',
  '$400-600K', 'C:\\path\\to\\file', 'end with backslash\\', 'x < y > z', '😀 emoji · dots… “quotes”', '...ellipsis...',
];

const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// The only HTML allowed in the output: autolinks whose visible text is their own
// target, and OpenClaw's <code> wrapping of file names. Visible text must equal
// the input (zero-width spaces aside).
function problems(input, html) {
  const found = [];
  const unlinked = html.replace(/<a href="([^"]*)">([^<]*)<\/a>/g, (m, href, text) => {
    let target = decode(href);
    try { target = decodeURI(target); } catch { /* keep */ }
    const shown = decode(text).replace(/\u200b/g, '');
    if (![shown, `http://${shown}`, `https://${shown}`, `mailto:${shown}`].includes(target)) found.push(`link to ${href} shown as "${text}"`);
    if (/xn--|%E2%80%8B/i.test(href)) found.push(`lookalike link ${href}`);
    return text;
  });
  const tags = unlinked.replace(/<code>([^<]*)<\/code>/g, '$1').match(/<\/?[a-z][^>]*>/gi);
  if (tags) found.push(`tags ${[...new Set(tags)].join(' ')}`);
  const visible = decode(unlinked.replace(/<\/?[a-z][^>]*>/gi, '')).replace(/\u200b/g, '');
  if (visible !== input) found.push(`shows ${JSON.stringify(visible)}`);
  return found;
}

test('card text renders literally through the installed OpenClaw renderer', {skip}, async () => {
  const {[found.alias]: planPages} = await import(found.file);
  const render = text => planPages({text, maxChars: 4000, chunkMode: 'length'}).map(p => p.htmlText ?? '').join('');
  const failures = CORPUS.map(input => ({input, found: problems(input, render(escapeMarkdown(input)))})).filter(f => f.found.length);
  assert.deepEqual(failures, []);
});

test('a whole /cardlake reply renders without injected markup', {skip}, async () => {
  const {[found.alias]: planPages} = await import(found.file);
  const evil = '<a href="https://evil.example">Pay</a> ||x|| *b*';
  const session = {
    filter: {label: '', args: {}}, index: 0, page: 0, nextCursor: null, notice: evil,
    cards: [{id: 'a', type: 'reminder', title: evil, subtitle: evil, metadata: {completed: false, due_date: null, url: 'https://evil.example/x_y'}}],
  };
  const {text} = renderView(session, {now: new Date(), timeZone: 'UTC', markdown: true, record: {status: 'done', label: evil}, callback: op => op});
  const html = planPages({text, maxChars: 4000, chunkMode: 'length'}).map(p => p.htmlText ?? '').join('');
  assert.ok(!/<(a|b|i|u|s|tg-spoiler|blockquote|pre)[\s>]/i.test(html), html);
  assert.ok(!html.includes('evil.example">'), html);
});
