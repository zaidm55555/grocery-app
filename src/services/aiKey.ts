import * as SecureStore from 'expo-secure-store';

// The user's own Groq API key for AI mode, kept in the OS keystore (iOS Keychain /
// Android Keystore-backed SharedPreferences) rather than AsyncStorage, which is
// plain text on disk.
//
// SECURITY TRADEOFF: a key held by the client is extractable. Anyone with the
// unlocked device, a rooted/jailbroken phone or a debugger attached to the app
// can read it out of memory or the keystore, and every request carries it in
// the Authorization header. That is acceptable here only because each user
// brings (and can revoke) their own key and nothing is bundled in the app. A
// shared or paid key must NOT ship this way: put it behind a backend proxy that
// holds the secret, authenticates the app user and rate-limits calls.
const SECURE_KEY = 'groq_api_key';

// Not migrated to a new device through an iCloud/iTunes backup.
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// SecureStore has no web implementation. There the key lives in memory only and
// is gone on reload, so it never lands in localStorage.
let memoryKey: string | null = null;

async function secureAvailable(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

/** Groq keys look like `gsk_` followed by a long token, with no whitespace. */
export function looksLikeGroqKey(value: string): boolean {
  return /^gsk_[A-Za-z0-9]{20,200}$/.test(value.trim());
}

/** Short form for display, never the full key: `gsk_…AbCd`. */
export function maskKey(value: string): string {
  const v = value.trim();
  return v.length <= 8 ? '••••' : `${v.slice(0, 4)}…${v.slice(-4)}`;
}

export const aiKey = {
  async get(): Promise<string | null> {
    if (!(await secureAvailable())) return memoryKey;
    try {
      return await SecureStore.getItemAsync(SECURE_KEY, OPTIONS);
    } catch {
      // An entry invalidated by the OS (e.g. restored from backup) reads as missing.
      return null;
    }
  },

  async save(value: string): Promise<void> {
    const v = value.trim();
    if (!looksLikeGroqKey(v)) throw new Error('That does not look like a Groq API key (it should start with gsk_).');
    if (!(await secureAvailable())) {
      memoryKey = v;
      return;
    }
    await SecureStore.setItemAsync(SECURE_KEY, v, OPTIONS);
  },

  async clear(): Promise<void> {
    memoryKey = null;
    if (!(await secureAvailable())) return;
    try {
      await SecureStore.deleteItemAsync(SECURE_KEY, OPTIONS);
    } catch {}
  },

  /** False on web, where the key cannot be persisted securely. */
  isPersistent: secureAvailable,
};
