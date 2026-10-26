import { aiProxy, getAiProxyConfig } from '../aiProxy';

// Fake values only.
const URL_BASE = 'https://ai-proxy.example.workers.dev';
const TOKEN = 'test-app-token-not-real';
const ORIGINAL = {
  url: process.env.EXPO_PUBLIC_AI_PROXY_URL,
  token: process.env.EXPO_PUBLIC_AI_PROXY_TOKEN,
};

const setEnv = (url: string | undefined, token: string | undefined) => {
  if (url === undefined) delete process.env.EXPO_PUBLIC_AI_PROXY_URL;
  else process.env.EXPO_PUBLIC_AI_PROXY_URL = url;
  if (token === undefined) delete process.env.EXPO_PUBLIC_AI_PROXY_TOKEN;
  else process.env.EXPO_PUBLIC_AI_PROXY_TOKEN = token;
};

afterEach(() => setEnv(ORIGINAL.url, ORIGINAL.token));

describe('aiProxy (EXPO_PUBLIC_AI_PROXY_URL / EXPO_PUBLIC_AI_PROXY_TOKEN)', () => {
  it('reads both values, trimmed, and targets /chat on the base URL', async () => {
    setEnv(`  ${URL_BASE}/ \n`, `  ${TOKEN}\n`);
    const expected = { url: `${URL_BASE}/chat`, token: TOKEN };
    expect(getAiProxyConfig()).toEqual(expected);
    expect(await aiProxy.get()).toEqual(expected);
  });

  it('accepts a URL that already ends in /chat, and plain http for local dev', () => {
    setEnv(`${URL_BASE}/chat`, TOKEN);
    expect(getAiProxyConfig()?.url).toBe(`${URL_BASE}/chat`);
    setEnv('http://192.168.1.20:8787', TOKEN);
    expect(getAiProxyConfig()?.url).toBe('http://192.168.1.20:8787/chat');
  });

  it.each([
    ['both unset', undefined, undefined],
    ['the URL unset', undefined, TOKEN],
    ['the token unset', URL_BASE, undefined],
    ['blank values (the .env.example default)', '  ', '   '],
    ['a URL without a scheme', 'ai-proxy.example.workers.dev', TOKEN],
  ])('is null with %s', async (_label, url, token) => {
    setEnv(url, token);
    expect(getAiProxyConfig()).toBeNull();
    expect(await aiProxy.get()).toBeNull();
  });
});
