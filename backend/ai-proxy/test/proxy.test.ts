import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import worker from '../src/index';
import {
  ALLOWED_MODELS,
  MAX_BODY_BYTES,
  MAX_COMPLETION_TOKENS,
  UPSTREAM_URL,
  handleRequest,
  matchOrigin,
  rateLimitKey,
  tokensMatch,
} from '../src/proxy';

// Obvious fakes only: these tests never touch the network.
const GROQ_KEY = 'test-groq-key-not-real';
const APP_TOKEN = 'test-app-token-not-real-0123';
const PROMPT = 'two dozen eggs';
const SYSTEM = 'system prompt text';

const APP_BODY = {
  model: ALLOWED_MODELS[0],
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: PROMPT },
  ],
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'grocery_request', strict: true, schema: { type: 'object' } },
  },
  temperature: 0.2,
  reasoning_effort: 'low',
  max_completion_tokens: 4096,
};

const COMPLETION = { choices: [{ message: { role: 'assistant', content: '{"items":[]}' }, finish_reason: 'stop' }] };

type Limit = Mock<(opts: { key: string }) => Promise<{ success: boolean }>>;

function makeEnv(over: Partial<Env> = {}): { env: Env; limit: Limit } {
  const limit: Limit = vi.fn(async () => ({ success: true }));
  const env = {
    GROQ_API_KEY: GROQ_KEY,
    APP_TOKEN,
    ALLOWED_ORIGINS: 'http://localhost:8081, https://app.example.com/',
    AI_RATE_LIMITER: { limit },
    ...over,
  } as Env;
  return { env, limit };
}

interface ReqOpts {
  method?: string;
  path?: string;
  body?: unknown;
  raw?: string | Uint8Array;
  headers?: Record<string, string>;
  omit?: string[];
}

function chatRequest(opts: ReqOpts = {}): Request {
  const method = opts.method ?? 'POST';
  const headers = new Headers({
    'Content-Type': 'application/json',
    'X-App-Token': APP_TOKEN,
    'CF-Connecting-IP': '203.0.113.7',
    ...opts.headers,
  });
  for (const name of opts.omit ?? []) headers.delete(name);
  const hasBody = method !== 'GET' && method !== 'OPTIONS';
  return new Request(`https://proxy.test${opts.path ?? '/chat'}`, {
    method,
    headers,
    body: hasBody ? (opts.raw ?? JSON.stringify(opts.body ?? APP_BODY)) : undefined,
  });
}

const upstreamJson = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

let fetchMock: Mock<typeof fetch>;
let consoleSpies: Mock[];

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>(async () => upstreamJson(200, COMPLETION));
  vi.stubGlobal('fetch', fetchMock);
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}));
});

afterEach(() => {
  // Whatever happened in the test, nothing secret or user-provided was logged.
  const logged = consoleSpies.flatMap(s => s.mock.calls.flat()).map(String).join('\n');
  for (const secret of [GROQ_KEY, APP_TOKEN, PROMPT, SYSTEM]) expect(logged).not.toContain(secret);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sentBody = () => JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
const sentHeaders = () => new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('POST /chat forwarding', () => {
  it('forwards a rebuilt request to Groq with the server key and returns the upstream answer', async () => {
    const { env, limit } = makeEnv();
    const res = await handleRequest(chatRequest(), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(COMPLETION);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(limit).toHaveBeenCalledWith({ key: 'ip:203.0.113.7' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(UPSTREAM_URL).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(sentHeaders().get('Authorization')).toBe(`Bearer ${GROQ_KEY}`);
    expect(sentHeaders().get('X-App-Token')).toBeNull();
    expect(sentBody()).toEqual({ ...APP_BODY, stream: false });
  });

  it('drops unknown fields, caps output tokens and fills safe defaults', async () => {
    const { env } = makeEnv();
    const { model: _model, reasoning_effort: _effort, temperature: _temp, ...rest } = APP_BODY;
    await handleRequest(chatRequest({
      body: { ...rest, max_completion_tokens: 100_000, stream: false, n: 3, seed: 7, user: 'someone', service_tier: 'flex' },
    }), env);
    expect(sentBody()).toEqual({
      model: ALLOWED_MODELS[0],
      messages: APP_BODY.messages,
      response_format: APP_BODY.response_format,
      reasoning_effort: 'low',
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      stream: false,
    });
  });

  it('keeps a smaller token budget, including the legacy max_tokens name', async () => {
    const { env } = makeEnv();
    const { max_completion_tokens: _max, ...rest } = APP_BODY;
    await handleRequest(chatRequest({ body: { ...rest, max_tokens: 256 } }), env);
    expect(sentBody().max_completion_tokens).toBe(256);
  });

  it('accepts a JSON content type with a charset', async () => {
    const { env } = makeEnv();
    const res = await handleRequest(chatRequest({ headers: { 'Content-Type': 'application/json; charset=utf-8' } }), env);
    expect(res.status).toBe(200);
  });

  it('passes upstream errors through with their status, body and Retry-After', async () => {
    const { env } = makeEnv();
    fetchMock.mockResolvedValueOnce(upstreamJson(429, { error: { message: 'Rate limit reached' } }, { 'Retry-After': '7' }));
    const limited = await handleRequest(chatRequest(), env);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('7');
    expect(await limited.json()).toEqual({ error: { message: 'Rate limit reached' } });

    fetchMock.mockResolvedValueOnce(upstreamJson(400, { error: { message: 'schema invalid' } }));
    const bad = await handleRequest(chatRequest(), env);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { message: 'schema invalid' } });
  });

  it.each([401, 403])('turns Groq rejecting the server key (%s) into a generic 502', async status => {
    const { env } = makeEnv();
    fetchMock.mockResolvedValueOnce(upstreamJson(status, { error: { message: `Invalid API Key ${GROQ_KEY}` } }));
    const res = await handleRequest(chatRequest(), env);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe('upstream_auth');
    expect(text).not.toContain(GROQ_KEY);
  });

  it('answers 502 when Groq is unreachable and 504 when it times out', async () => {
    const { env } = makeEnv();
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await handleRequest(chatRequest(), env)).status).toBe(502);
    fetchMock.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
    expect((await handleRequest(chatRequest(), env)).status).toBe(504);
  });
});

describe('app token, rate limit and request checks', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['wrong', 'nope'],
    ['a prefix of the real one', APP_TOKEN.slice(0, -1)],
    ['the real one plus extra', `${APP_TOKEN}x`],
  ])('rejects a %s token with 401 and never calls Groq', async (_label, token) => {
    const { env } = makeEnv();
    const req = token === undefined
      ? chatRequest({ omit: ['X-App-Token'] })
      : chatRequest({ headers: { 'X-App-Token': token } });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('unauthorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rate-limits per IP before checking the token', async () => {
    const { env, limit } = makeEnv();
    limit.mockResolvedValue({ success: false });
    const res = await handleRequest(chatRequest({ headers: { 'X-App-Token': 'guess' } }), env);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(await errorCode(res)).toBe('rate_limited');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the rate limiter errors', async () => {
    const { env, limit } = makeEnv();
    limit.mockRejectedValue(new Error('limiter down'));
    expect((await handleRequest(chatRequest(), env)).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['no Groq key', { GROQ_API_KEY: '' }],
    ['no app token', { APP_TOKEN: '' }],
    ['a too-short app token', { APP_TOKEN: 'short' }],
  ] as [string, Partial<Env>][])('refuses to run with %s configured', async (_label, over) => {
    const { env } = makeEnv(over);
    const res = await handleRequest(chatRequest(), env);
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a JSON content type', async () => {
    const { env } = makeEnv();
    const res = await handleRequest(chatRequest({ headers: { 'Content-Type': 'text/plain' } }), env);
    expect(res.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects bodies over the size cap without forwarding them', async () => {
    const { env } = makeEnv();
    const big = JSON.stringify({ ...APP_BODY, messages: [{ role: 'user', content: 'x'.repeat(MAX_BODY_BYTES) }] });
    const res = await handleRequest(chatRequest({ raw: big }), env);
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a declared Content-Length over the cap before reading the body', async () => {
    const { env } = makeEnv();
    const res = await handleRequest(chatRequest({ headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) } }), env);
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a body just under the size cap', async () => {
    const { env } = makeEnv();
    const base = JSON.stringify({ ...APP_BODY, messages: [{ role: 'user', content: '' }] });
    const fill = MAX_BODY_BYTES - new TextEncoder().encode(base).byteLength;
    const res = await handleRequest(chatRequest({ raw: JSON.stringify({ ...APP_BODY, messages: [{ role: 'user', content: 'y'.repeat(fill) }] }) }), env);
    expect(res.status).toBe(200);
  });

  it.each([
    ['malformed JSON', '{"messages": ['],
    ['an empty body', ''],
    ['a JSON array', '[]'],
    ['invalid UTF-8', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])],
  ])('rejects %s with 400', async (_label, raw) => {
    const { env } = makeEnv();
    const res = await handleRequest(chatRequest({ raw }), env);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const { response_format: _rf, ...noFormat } = APP_BODY;
  it.each([
    ['another model', { ...APP_BODY, model: 'llama-3.3-70b-versatile' }],
    ['streaming', { ...APP_BODY, stream: true }],
    ['tools', { ...APP_BODY, tools: [{ type: 'browser_search' }] }],
    ['tool_choice', { ...APP_BODY, tool_choice: 'auto' }],
    ['functions', { ...APP_BODY, functions: [] }],
    ['function_call', { ...APP_BODY, function_call: 'auto' }],
    ['no messages', { ...APP_BODY, messages: [] }],
    ['too many messages', { ...APP_BODY, messages: Array(5).fill({ role: 'user', content: 'hi' }) }],
    ['an assistant message', { ...APP_BODY, messages: [{ role: 'assistant', content: 'hi' }] }],
    ['an empty message', { ...APP_BODY, messages: [{ role: 'user', content: '  ' }] }],
    ['non-text content', { ...APP_BODY, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }],
    ['no response_format', noFormat],
    ['a plain JSON response_format', { ...APP_BODY, response_format: { type: 'json_object' } }],
    ['a bad schema name', { ...APP_BODY, response_format: { type: 'json_schema', json_schema: { name: 'a b', schema: {} } } }],
    ['a missing schema', { ...APP_BODY, response_format: { type: 'json_schema', json_schema: { name: 'x' } } }],
    ['a non-boolean strict', { ...APP_BODY, response_format: { type: 'json_schema', json_schema: { name: 'x', strict: 'yes', schema: {} } } }],
    ['temperature out of range', { ...APP_BODY, temperature: 3 }],
    ['an unknown reasoning_effort', { ...APP_BODY, reasoning_effort: 'max' }],
    ['zero max tokens', { ...APP_BODY, max_completion_tokens: 0 }],
    ['fractional max tokens', { ...APP_BODY, max_completion_tokens: 1.5 }],
    ['string max tokens', { ...APP_BODY, max_completion_tokens: '100' }],
  ])('rejects a request with %s', async (_label, body) => {
    const { env } = makeEnv();
    const res = await handleRequest(chatRequest({ body }), env);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('routing and CORS', () => {
  it('only serves /chat', async () => {
    const { env } = makeEnv();
    expect((await handleRequest(chatRequest({ path: '/' }), env)).status).toBe(404);
    expect((await handleRequest(chatRequest({ path: '/v1/chat/completions' }), env)).status).toBe(404);
    const get = await handleRequest(chatRequest({ method: 'GET' }), env);
    expect(get.status).toBe(405);
    expect(get.headers.get('Allow')).toBe('POST, OPTIONS');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a preflight from an allowed web origin', async () => {
    const { env, limit } = makeEnv();
    const res = await handleRequest(chatRequest({ method: 'OPTIONS', headers: { Origin: 'https://app.example.com' } }), env);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-App-Token');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    expect(limit).not.toHaveBeenCalled();
  });

  it('adds CORS headers to answers for an allowed origin', async () => {
    const { env } = makeEnv();
    const res = await handleRequest(chatRequest({ headers: { Origin: 'http://localhost:8081' } }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8081');
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it.each(['OPTIONS', 'POST'])('refuses %s from other origins', async method => {
    const { env } = makeEnv();
    const res = await handleRequest(chatRequest({ method, headers: { Origin: 'https://evil.example' } }), env);
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('matches origins from the comma-separated list', () => {
    expect(matchOrigin('http://localhost:8081', 'http://localhost:8081')).toBe('http://localhost:8081');
    expect(matchOrigin('https://app.example.com', ' http://a.test , https://app.example.com/ ')).toBe('https://app.example.com');
    expect(matchOrigin('https://other.test', 'http://localhost:8081')).toBeNull();
    expect(matchOrigin('https://other.test', '*')).toBe('*');
    expect(matchOrigin('null', 'http://localhost:8081')).toBeNull();
    expect(matchOrigin(null, '*')).toBeNull();
    expect(matchOrigin('http://localhost:8081', undefined)).toBeNull();
  });
});

describe('rateLimitKey', () => {
  it('keys IPv4 by address and IPv6 by /64', () => {
    expect(rateLimitKey('203.0.113.7')).toBe('ip:203.0.113.7');
    expect(rateLimitKey(null)).toBe('ip:unknown');
    expect(rateLimitKey('  ')).toBe('ip:unknown');
    const a = rateLimitKey('2001:db8:abcd:12:1::1');
    expect(a).toBe('ip6:2001:db8:abcd:12::/64');
    expect(rateLimitKey('2001:0DB8:abcd:0012:ffff:ffff:ffff:ffff')).toBe(a);
    expect(rateLimitKey('2001:db8:abcd:13::1')).not.toBe(a);
    expect(rateLimitKey('::1')).toBe('ip6:0:0:0:0::/64');
    expect(rateLimitKey('::ffff:198.51.100.2')).toBe('ip:198.51.100.2');
  });

  it('falls back to the raw value for addresses it cannot parse', () => {
    expect(rateLimitKey('zz::zz')).toBe('ip:zz::zz');
    expect(rateLimitKey('1::2::3')).toBe('ip:1::2::3');
    expect(rateLimitKey('1:2:3')).toBe('ip:1:2:3');
  });
});

describe('tokensMatch', () => {
  it('compares tokens exactly', async () => {
    expect(await tokensMatch(APP_TOKEN, APP_TOKEN)).toBe(true);
    expect(await tokensMatch(`${APP_TOKEN} `, APP_TOKEN)).toBe(false);
    expect(await tokensMatch('', APP_TOKEN)).toBe(false);
    expect(await tokensMatch('', '')).toBe(false);
  });
});

describe('worker entry point', () => {
  it('delegates to the handler', async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(chatRequest() as Parameters<typeof worker.fetch>[0], env);
    expect(res.status).toBe(200);
  });

  it('hides unexpected errors behind a generic 500', async () => {
    const { env } = makeEnv();
    Object.defineProperty(env, 'ALLOWED_ORIGINS', { get() { throw new Error(`boom ${GROQ_KEY}`); } });
    const res = await worker.fetch(chatRequest() as Parameters<typeof worker.fetch>[0], env);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(GROQ_KEY);
  });
});
