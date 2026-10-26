// Where AI mode sends its requests. The app never holds the Groq key: it calls
// BasketBuddy's own proxy (backend/ai-proxy, a Cloudflare Worker that keeps the
// Groq key as a Workers secret) and identifies itself with a shared app token.
//
// Both values come from EXPO_PUBLIC_AI_PROXY_URL and EXPO_PUBLIC_AI_PROXY_TOKEN
// (set them in the gitignored .env.local; see .env.example). Expo inlines
// EXPO_PUBLIC_ variables into the JS bundle at build time, so they must be read
// with this exact static `process.env.EXPO_PUBLIC_...` form (no destructuring or
// computed access).
//
// SECURITY: the app token is NOT a secret. It ships inside every build, so anyone
// with the APK/IPA or a debugger can extract it. It only keeps casual abuse
// (scanners, someone who stumbles on the URL) off the proxy; the proxy's per-IP
// rate limit, model allow-list and output-token cap bound what a determined
// abuser can do. Real per-user auth is the planned upgrade before a wide release.

export interface AiProxyConfig {
  /** Full endpoint, e.g. https://basketbuddy-ai-proxy.<account>.workers.dev/chat */
  url: string;
  /** Sent as the X-App-Token header. */
  token: string;
}

/**
 * The configured proxy, or null when either variable is unset, blank, or the
 * URL is not http(s). The URL may be the Worker's base URL or end in /chat.
 */
export function getAiProxyConfig(): AiProxyConfig | null {
  const base = process.env.EXPO_PUBLIC_AI_PROXY_URL?.trim();
  const token = process.env.EXPO_PUBLIC_AI_PROXY_TOKEN?.trim();
  if (!base || !token || !/^https?:\/\/[^/\s]+/i.test(base)) return null;
  const root = base.replace(/\/+$/, '');
  return { url: /\/chat$/i.test(root) ? root : `${root}/chat`, token };
}

export const aiProxy = {
  /** Async so callers need not change if this later comes from a sign-in session. */
  async get(): Promise<AiProxyConfig | null> {
    return getAiProxyConfig();
  },
};
