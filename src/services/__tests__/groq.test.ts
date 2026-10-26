import { groqJson, GroqError, GROQ_MODEL } from '../groq';

// Fake values only.
const PROXY = { url: 'https://ai-proxy.example.workers.dev/chat', token: 'test-app-token-not-real' };

const response = (status: number, body: unknown, raw = false) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (raw) throw new SyntaxError('bad json');
    return body;
  },
}) as unknown as Response;

const completion = (content: unknown, finish = 'stop') =>
  response(200, { choices: [{ message: { role: 'assistant', content }, finish_reason: finish }] });

const call = (fetchImpl: jest.Mock, extra: Partial<Parameters<typeof groqJson>[0]> = {}) =>
  groqJson({
    proxy: PROXY,
    system: 'sys',
    user: 'two dozen eggs',
    schemaName: 'grocery_request',
    schema: { type: 'object' },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...extra,
  });

const rejection = async (p: Promise<unknown>): Promise<GroqError> => {
  try {
    await p;
  } catch (e) {
    return e as GroqError;
  }
  throw new Error('expected a rejection');
};

describe('groqJson', () => {
  it('posts a strict json_schema request to the AI proxy with the app token and parses the reply', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(completion('{"items":[{"name":"Eggs"}]}'));
    await expect(call(fetchImpl)).resolves.toEqual({ items: [{ name: 'Eggs' }] });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(PROXY.url);
    expect(init.method).toBe('POST');
    expect(init.headers['X-App-Token']).toBe(PROXY.token);
    // The app holds no Groq key, so it never sends one.
    expect(init.headers.Authorization).toBeUndefined();
    const body = JSON.parse(init.body);
    expect(body.model).toBe(GROQ_MODEL);
    expect(body.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'two dozen eggs' }]);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'grocery_request', strict: true, schema: { type: 'object' } },
    });
    expect(body.reasoning_effort).toBe('low');
  });

  it.each([
    [401, 'auth', 'The AI service rejected this app. Check EXPO_PUBLIC_AI_PROXY_TOKEN.'],
    [403, 'auth', 'The AI service refused requests from here (origin not allowed).'],
    [429, 'rate_limit', 'Too many AI requests. Wait a minute and try again.'],
    [413, 'http', 'That request is too big for AI mode. Try fewer items.'],
  ])('maps proxy HTTP %s to a %s error without leaking the token', async (status, kind, message) => {
    const fetchImpl = jest.fn().mockResolvedValue(response(status, { error: { message: `server said ${PROXY.token}` } }));
    const err = await rejection(call(fetchImpl));
    expect(err).toBeInstanceOf(GroqError);
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
    expect(err.message).toBe(message);
    expect(err.message).not.toContain(PROXY.token);
  });

  it('includes the server message on other HTTP errors, and survives an unreadable body', async () => {
    const withMsg = await rejection(call(jest.fn().mockResolvedValue(response(400, { error: { message: 'model not found' } }))));
    expect(withMsg.kind).toBe('http');
    expect(withMsg.message).toBe('AI request failed (400): model not found');
    const upstreamAuth = await rejection(call(jest.fn().mockResolvedValue(
      response(502, { error: { code: 'upstream_auth', message: 'The AI provider rejected the proxy credentials.' } }),
    )));
    expect(upstreamAuth.kind).toBe('http');
    expect(upstreamAuth.message).toBe('AI request failed (502): The AI provider rejected the proxy credentials.');
    const noBody = await rejection(call(jest.fn().mockResolvedValue(response(500, null, true))));
    expect(noBody.message).toBe('AI request failed (500)');
  });

  it.each([
    ['empty content', completion('')],
    ['non-string content', completion({ items: [] })],
    ['malformed JSON', completion('{"items": [')],
    ['no choices', response(200, { choices: [] })],
    ['unreadable body', response(200, null, true)],
    ['truncated answer', completion('{"items":[]}', 'length')],
  ])('rejects %s as bad_response', async (_label, res) => {
    const err = await rejection(call(jest.fn().mockResolvedValue(res)));
    expect(err.kind).toBe('bad_response');
  });

  it('reports network failures', async () => {
    const err = await rejection(call(jest.fn().mockRejectedValue(new TypeError('Network request failed'))));
    expect(err.kind).toBe('network');
  });

  it('reports a cancel when the caller aborts', async () => {
    const ctrl = new AbortController();
    const fetchImpl = jest.fn((_url, init: RequestInit) => new Promise((_res, rej) => {
      init.signal!.addEventListener('abort', () => rej(new Error('aborted')));
    }));
    const p = call(fetchImpl as unknown as jest.Mock, { signal: ctrl.signal });
    ctrl.abort();
    expect((await rejection(p)).kind).toBe('aborted');
  });

  it('times out a request that never answers', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest.fn((_url, init: RequestInit) => new Promise((_res, rej) => {
        init.signal!.addEventListener('abort', () => rej(new Error('aborted')));
      }));
      const p = call(fetchImpl as unknown as jest.Mock);
      jest.advanceTimersByTime(60000);
      expect((await rejection(p)).kind).toBe('timeout');
    } finally {
      jest.useRealTimers();
    }
  });
});
