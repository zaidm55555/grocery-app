// The Groq API key for AI mode, read from EXPO_PUBLIC_GROQ_API_KEY (set it in the
// gitignored .env.local; see .env.example). Expo inlines EXPO_PUBLIC_ variables
// into the JS bundle at build time, so it must be read with this exact static
// `process.env.EXPO_PUBLIC_...` form (no destructuring or computed access).
//
// SECURITY TRADEOFF: this bundles the key into the app binary, where anyone with
// the APK/IPA or a debugger can extract it, and every request carries it in the
// Authorization header. That is fine for personal testing only. Before any
// public release the key must move behind a backend proxy that holds the
// secret, authenticates the app user and rate-limits calls.

/** The configured key, or null when EXPO_PUBLIC_GROQ_API_KEY is unset or blank. */
export function getGroqKey(): string | null {
  const key = process.env.EXPO_PUBLIC_GROQ_API_KEY?.trim();
  return key ? key : null;
}

export const aiKey = {
  /** Async so callers need not change if the key later comes from a backend. */
  async get(): Promise<string | null> {
    return getGroqKey();
  },
};
