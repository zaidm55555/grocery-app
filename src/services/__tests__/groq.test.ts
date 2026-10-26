import { groqJson, GroqError, GROQ_MODEL } from '../groq';

const KEY = 'gsk_testkey1234567890abcdef';

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
    apiKey: KEY,
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
  it('posts a strict json_schema request with the key as a bearer token and parses the reply', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(completion('{"items":[{"name":"Eggs"}]}'));
    await expect(call(fetchImpl)).resolves.toEqual({ items: [{ name: 'Eggs' }] });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
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
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
  ])('maps HTTP %s to a %s error without leaking the key', async (status, kind) => {
    const fetchImpl = jest.fn().mockResolvedValue(response(status, {}));
    const err = await rejection(call(fetchImpl));
    expect(err).toBeInstanceOf(GroqError);
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
    expect(err.message).not.toContain(KEY);
  });

  it('includes the server message on other HTTP errors, and survives an unreadable body', async () => {
    const withMsg = await rejection(call(jest.fn().mockResolvedValue(response(400, { error: { message: 'model not found' } }))));
    expect(withMsg.kind).toBe('http');
    expect(withMsg.message).toBe('Groq request failed (400): model not found');
    const noBody = await rejection(call(jest.fn().mockResolvedValue(response(500, null, true))));
    expect(noBody.message).toBe('Groq request failed (500)');
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
