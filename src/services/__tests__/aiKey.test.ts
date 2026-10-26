import { aiKey, getGroqKey } from '../aiKey';

const KEY = 'gsk_test' + 'A1b2C3d4'.repeat(4);
const ORIGINAL = process.env.EXPO_PUBLIC_GROQ_API_KEY;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.EXPO_PUBLIC_GROQ_API_KEY;
  else process.env.EXPO_PUBLIC_GROQ_API_KEY = ORIGINAL;
});

describe('aiKey (EXPO_PUBLIC_GROQ_API_KEY)', () => {
  it('reads the key from the env var, trimmed', async () => {
    process.env.EXPO_PUBLIC_GROQ_API_KEY = `  ${KEY}\n`;
    expect(getGroqKey()).toBe(KEY);
    expect(await aiKey.get()).toBe(KEY);
  });

  it('is null when the env var is unset', async () => {
    delete process.env.EXPO_PUBLIC_GROQ_API_KEY;
    expect(getGroqKey()).toBeNull();
    expect(await aiKey.get()).toBeNull();
  });

  it('is null when the env var is blank (the .env.example default)', async () => {
    process.env.EXPO_PUBLIC_GROQ_API_KEY = '   ';
    expect(getGroqKey()).toBeNull();
    expect(await aiKey.get()).toBeNull();
  });
});
