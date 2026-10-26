import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { aiKey, looksLikeGroqKey, maskKey } from '../aiKey';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
    isAvailableAsync: jest.fn(async () => true),
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
    __store: store,
  };
});

const ss = SecureStore as unknown as {
  isAvailableAsync: jest.Mock; getItemAsync: jest.Mock; setItemAsync: jest.Mock; deleteItemAsync: jest.Mock; __store: Map<string, string>;
};
const KEY = 'gsk_' + 'A1b2C3d4'.repeat(6);

beforeEach(async () => {
  // Re-armed every test: the global afterEach restoreAllMocks may reset module-mock implementations.
  ss.__store.clear();
  ss.isAvailableAsync.mockReset().mockResolvedValue(true);
  ss.getItemAsync.mockReset().mockImplementation(async (k: string) => ss.__store.get(k) ?? null);
  ss.setItemAsync.mockReset().mockImplementation(async (k: string, v: string) => { ss.__store.set(k, v); });
  ss.deleteItemAsync.mockReset().mockImplementation(async (k: string) => { ss.__store.delete(k); });
  await aiKey.clear();
  await AsyncStorage.clear();
});

describe('looksLikeGroqKey / maskKey', () => {
  it('accepts gsk_ keys and rejects anything else', () => {
    expect(looksLikeGroqKey(KEY)).toBe(true);
    expect(looksLikeGroqKey(`  ${KEY}\n`)).toBe(true);
    expect(looksLikeGroqKey('sk-abc1234567890123456789')).toBe(false);
    expect(looksLikeGroqKey('gsk_short')).toBe(false);
    expect(looksLikeGroqKey('gsk_abc def ghi jkl mno pqr stu')).toBe(false);
    expect(looksLikeGroqKey('')).toBe(false);
  });

  it('never shows more than the prefix and last 4 characters', () => {
    expect(maskKey(KEY)).toBe(`gsk_…${KEY.slice(-4)}`);
    expect(maskKey('abc')).toBe('••••');
  });
});

describe('aiKey', () => {
  it('stores the key in SecureStore (this device only), not AsyncStorage', async () => {
    await aiKey.save(`  ${KEY} `);
    expect(ss.setItemAsync).toHaveBeenCalledWith('groq_api_key', KEY, { keychainAccessible: 7 });
    expect(await aiKey.get()).toBe(KEY);
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
  });

  it('refuses to save something that is not a Groq key', async () => {
    await expect(aiKey.save('hello')).rejects.toThrow(/gsk_/);
    expect(ss.setItemAsync).not.toHaveBeenCalled();
  });

  it('clears the key', async () => {
    await aiKey.save(KEY);
    await aiKey.clear();
    expect(ss.deleteItemAsync).toHaveBeenCalledWith('groq_api_key', { keychainAccessible: 7 });
    expect(await aiKey.get()).toBeNull();
  });

  it('reads an unreadable entry as missing', async () => {
    ss.getItemAsync.mockRejectedValueOnce(new Error('invalidated'));
    expect(await aiKey.get()).toBeNull();
  });

  it('keeps the key in memory only where SecureStore is unavailable (web)', async () => {
    ss.isAvailableAsync.mockResolvedValue(false);
    expect(await aiKey.isPersistent()).toBe(false);
    await aiKey.save(KEY);
    expect(ss.setItemAsync).not.toHaveBeenCalled();
    expect(await aiKey.get()).toBe(KEY);
    await aiKey.clear();
    expect(await aiKey.get()).toBeNull();
  });

  it('treats a throwing availability check as unavailable', async () => {
    ss.isAvailableAsync.mockRejectedValue(new Error('no native module'));
    expect(await aiKey.isPersistent()).toBe(false);
  });
});
