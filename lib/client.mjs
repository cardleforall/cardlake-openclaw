// Cardlake MCP client for the OpenClaw plugin. Same wire protocol as
// __init__._rpc, but failures are classified so the Telegram view can say what
// went wrong and whether a write might have been applied anyway.

const DEFAULT_BASE = 'https://cardlake.app';
const TIMEOUT_MS = 15000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// kind: config | auth | not_found | rejected | network | server | protocol
// uncertain: the request reached (or may have reached) Cardlake, but we never
// got a readable answer, so a write may or may not have happened.
export class CardlakeError extends Error {
  constructor(kind, message, {uncertain = false} = {}) {
    super(message);
    this.name = 'CardlakeError';
    this.kind = kind;
    this.uncertain = uncertain;
  }
}

export function mcpEndpoint(base) {
  let url;
  try { url = new URL(base); } catch { throw new Error('CARDLAKE_API_URL is not a valid URL'); }
  // The bearer token goes to this host: refuse plaintext except on loopback,
  // and refuse embedded credentials or query strings that could leak it.
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure) throw new Error('CARDLAKE_API_URL must use https');
  if (url.username || url.password || url.search || url.hash) throw new Error('CARDLAKE_API_URL must be a plain base URL');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/mcp`;
  return url.href;
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function firstText(result) {
  const item = Array.isArray(result.content) ? result.content.find(c => c?.type === 'text' && typeof c.text === 'string') : null;
  return item ? item.text : '';
}

function clip(text, max = 200) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

async function readEnvelope(response, id) {
  const type = response.headers?.get?.('content-type')?.toLowerCase() ?? '';
  if (!type.includes('text/event-stream')) return await response.json();
  // Streamable HTTP: take the single JSON-RPC message answering our request.
  const body = await response.text();
  const messages = body.split(/\r?\n\r?\n/)
    .map(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))
    .filter(Boolean)
    .map(data => { try { return JSON.parse(data); } catch { return null; } })
    .filter(message => message?.id === id);
  if (messages.length !== 1) throw new Error('no single response in event stream');
  return messages[0];
}

function toolError(result) {
  const text = clip(firstText(result).replace(/^Error:\s*/i, '')) || 'Cardlake reported an error';
  if (/not found/i.test(text)) return new CardlakeError('not_found', text);
  if (/unauthori[sz]ed|forbidden|invalid token|expired token/i.test(text)) return new CardlakeError('auth', text);
  return new CardlakeError('rejected', text);
}

export function createClient({
  token = process.env.CARDLAKE_API_TOKEN,
  base = process.env.CARDLAKE_API_URL || DEFAULT_BASE,
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  let endpoint = null;
  let configError = null;
  if (!token) configError = 'CARDLAKE_API_TOKEN is not set';
  else {
    try { endpoint = mcpEndpoint(base); } catch (e) { configError = e.message; }
  }
  let nextId = 1;

  async function call(name, args = {}) {
    if (configError) throw new CardlakeError('config', configError);
    const id = nextId++;
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({jsonrpc: '2.0', id, method: 'tools/call', params: {name, arguments: args}}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Includes timeouts after the request was sent.
      throw new CardlakeError('network', 'Could not reach Cardlake', {uncertain: true});
    }
    if (response.status === 401 || response.status === 403)
      throw new CardlakeError('auth', 'Cardlake rejected the API token');
    if (!response.ok) {
      const server = response.status >= 500;
      throw new CardlakeError(server ? 'server' : 'rejected', `Cardlake answered HTTP ${response.status}`, {uncertain: server});
    }
    let envelope;
    try { envelope = await readEnvelope(response, id); } catch {
      throw new CardlakeError('protocol', 'Cardlake sent an unreadable response', {uncertain: true});
    }
    if (!isObject(envelope) || envelope.jsonrpc !== '2.0' || envelope.id !== id)
      throw new CardlakeError('protocol', 'Cardlake sent an unexpected response', {uncertain: true});
    if (envelope.error) throw new CardlakeError('rejected', clip(envelope.error.message || 'Cardlake reported an error'));
    const result = envelope.result;
    if (!isObject(result)) throw new CardlakeError('protocol', 'Cardlake sent an empty response', {uncertain: true});
    if (result.isError) throw toolError(result);
    if (isObject(result.structuredContent)) return result.structuredContent;
    try {
      const data = JSON.parse(firstText(result));
      if (isObject(data)) return data;
    } catch { /* fall through */ }
    throw new CardlakeError('protocol', 'Cardlake sent an unexpected response', {uncertain: true});
  }

  return {call, configError};
}
