/**
 * BasketBuddy AI proxy (Cloudflare Worker).
 *
 * The app's AI mode POSTs OpenAI-style chat requests to /chat here instead of
 * calling Groq directly, so the Groq API key lives only in this Worker's
 * secrets (GROQ_API_KEY) and never ships in the app.
 *
 * What protects this endpoint, and how much:
 * - X-App-Token must equal the APP_TOKEN secret. This is ONE SHARED token that is
 *   compiled into every app build (EXPO_PUBLIC_AI_PROXY_TOKEN), so anyone with the
 *   APK/IPA or a debugger can extract it. It only blocks casual abuse (scanners,
 *   someone who stumbles on the URL). It is not user authentication; real per-user
 *   auth (sign-in with short-lived tokens, or App Attest / Play Integrity) is the
 *   upgrade to make before a broad public release.
 * - A per-IP rate limit (Workers Rate Limiting binding: approximate, per location).
 * - The upstream request is rebuilt from an allow-list: one model, system/user
 *   messages, a required JSON-schema response format, capped output tokens, no
 *   streaming and no tools. Even with the token it is a poor general LLM endpoint.
 *
 * Nothing here logs the Groq key, the app token, or request/response bodies.
 */

export const UPSTREAM_URL = 'https://api.groq.com/openai/v1/chat/completions';
/** Keep in sync with GROQ_MODEL in the app (src/services/groq.ts). */
export const ALLOWED_MODELS: readonly string[] = ['openai/gpt-oss-120b'];
/** The largest legitimate AI-mode request (15 items x 12 store listings) is about 43 KB. */
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_COMPLETION_TOKENS = 4096;
export const MAX_MESSAGES = 4;
export const UPSTREAM_TIMEOUT_MS = 40_000;
export const MIN_APP_TOKEN_LENGTH = 16;

const REASONING_EFFORTS = ['low', 'medium', 'high'];
const FORBIDDEN_FIELDS = ['tools', 'tool_choice', 'functions', 'function_call'];
const BASE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export function errorResponse(status: number, code: string, message: string, headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { ...BASE_HEADERS, ...headers, 'Content-Type': 'application/json' },
  });
}

/** The CORS origin to echo for `origin`, or null when it is not allowed. */
export function matchOrigin(origin: string | null, allowed: string | undefined): string | null {
  if (!origin) return null;
  const list = (allowed ?? '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (list.includes('*')) return '*';
  return list.includes(origin) ? origin : null;
}

/** First four groups of an IPv6 address (its /64), or null if it does not parse. */
function ipv6Prefix64(addr: string): string | null {
  const halves = addr.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const split = (s: string) => (s ? s.split(':') : []);
  const head = split(halves[0] ?? '');
  const tail = halves.length === 2 ? split(halves[1] ?? '') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (!groups.every(g => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':');
}

/**
 * Rate-limit bucket for a client IP (CF-Connecting-IP). IPv6 clients usually
 * control a whole /64, so they are limited per /64 rather than per address.
 */
export function rateLimitKey(ip: string | null): string {
  const value = (ip ?? '').trim();
  if (!value) return 'ip:unknown';
  if (!value.includes(':')) return `ip:${value}`;
  const v4 = value.match(/:(\d{1,3}(?:\.\d{1,3}){3})$/); // IPv4-mapped, e.g. ::ffff:203.0.113.7
  if (v4) return `ip:${v4[1]}`;
  const prefix = ipv6Prefix64(value);
  return prefix ? `ip6:${prefix}::/64` : `ip:${value}`;
}

/** Constant-time comparison: both sides are hashed first, so length leaks nothing either. */
export async function tokensMatch(given: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

type BodyResult = { text: string } | { error: 'too_large' | 'not_utf8' };

/** Reads at most `max` bytes, stopping early instead of buffering an oversized body. */
async function readBodyCapped(request: Request, max: number): Promise<BodyResult> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > max) return { error: 'too_large' };
  if (!request.body) return { text: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    size += chunk.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return { error: 'too_large' };
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) };
  } catch {
    return { error: 'not_utf8' };
  }
}

/**
 * Rebuilds the Groq request from allow-listed fields only. Unknown fields are
 * dropped; anything that would widen what the token can do is rejected.
 */
export function buildUpstreamBody(input: unknown): { body: Json } | { error: string } {
  if (!isObj(input)) return { error: 'Body must be a JSON object.' };
  if (input.stream !== undefined && input.stream !== false) return { error: 'Streaming is not supported.' };
  for (const field of FORBIDDEN_FIELDS) {
    if (input[field] !== undefined) return { error: `"${field}" is not allowed.` };
  }

  const model = input.model ?? ALLOWED_MODELS[0];
  if (typeof model !== 'string' || !ALLOWED_MODELS.includes(model)) return { error: 'That model is not allowed.' };

  const { messages } = input;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return { error: `messages must have 1 to ${MAX_MESSAGES} entries.` };
  }
  const cleanMessages: Json[] = [];
  for (const m of messages) {
    if (!isObj(m) || (m.role !== 'system' && m.role !== 'user') || typeof m.content !== 'string' || !m.content.trim()) {
      return { error: 'Each message needs role "system" or "user" and non-empty text content.' };
    }
    cleanMessages.push({ role: m.role, content: m.content });
  }

  const format = input.response_format;
  const spec = isObj(format) && format.type === 'json_schema' && isObj(format.json_schema) ? format.json_schema : null;
  if (!spec || typeof spec.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(spec.name) || !isObj(spec.schema)
    || (spec.strict !== undefined && typeof spec.strict !== 'boolean')) {
    return { error: 'response_format must be a json_schema with a name and a schema.' };
  }
  const jsonSchema: Json = { name: spec.name, schema: spec.schema };
  if (typeof spec.strict === 'boolean') jsonSchema.strict = spec.strict;

  const { temperature } = input;
  if (temperature !== undefined && (typeof temperature !== 'number' || !(temperature >= 0 && temperature <= 2))) {
    return { error: 'temperature must be a number from 0 to 2.' };
  }

  const effort = input.reasoning_effort ?? 'low';
  if (typeof effort !== 'string' || !REASONING_EFFORTS.includes(effort)) return { error: 'Unsupported reasoning_effort.' };

  const requested = input.max_completion_tokens ?? input.max_tokens;
  if (requested !== undefined && (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1)) {
    return { error: 'max_completion_tokens must be a positive integer.' };
  }

  const body: Json = {
    model,
    messages: cleanMessages,
    response_format: { type: 'json_schema', json_schema: jsonSchema },
    reasoning_effort: effort,
    max_completion_tokens: Math.min(requested ?? MAX_COMPLETION_TOKENS, MAX_COMPLETION_TOKENS),
    stream: false,
  };
  if (temperature !== undefined) body.temperature = temperature;
  return { body };
}

const isJsonContentType = (value: string | null) => !!value && /^application\/json\s*(;|$)/i.test(value.trim());

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const allowedOrigin = matchOrigin(origin, env.ALLOWED_ORIGINS);
  const cors: Record<string, string> = allowedOrigin
    ? { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Expose-Headers': 'Retry-After', Vary: 'Origin' }
    : { Vary: 'Origin' };

  if (url.pathname !== '/chat') return errorResponse(404, 'not_found', 'Not found.', cors);
  // Browsers always send Origin cross-site; native apps send none.
  if (origin !== null && !allowedOrigin) {
    return errorResponse(403, 'origin_not_allowed', 'This origin may not use the AI proxy.', cors);
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...BASE_HEADERS,
        ...cors,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.', { ...cors, Allow: 'POST, OPTIONS' });
  }

  if (!env.GROQ_API_KEY || !env.APP_TOKEN || env.APP_TOKEN.length < MIN_APP_TOKEN_LENGTH || !env.AI_RATE_LIMITER) {
    console.error(`ai-proxy misconfigured: needs GROQ_API_KEY, APP_TOKEN (${MIN_APP_TOKEN_LENGTH}+ chars) and AI_RATE_LIMITER`);
    return errorResponse(500, 'not_configured', 'The AI proxy is not configured.', cors);
  }

  // Before the token check, so guessing tokens is throttled too.
  let withinLimit: boolean;
  try {
    ({ success: withinLimit } = await env.AI_RATE_LIMITER.limit({ key: rateLimitKey(request.headers.get('CF-Connecting-IP')) }));
  } catch {
    console.error('ai-proxy: rate limiter unavailable');
    return errorResponse(503, 'unavailable', 'The AI proxy is unavailable. Try again shortly.', cors);
  }
  if (!withinLimit) {
    return errorResponse(429, 'rate_limited', 'Too many requests. Try again in a minute.', { ...cors, 'Retry-After': '60' });
  }

  if (!(await tokensMatch(request.headers.get('X-App-Token') ?? '', env.APP_TOKEN))) {
    return errorResponse(401, 'unauthorized', 'Missing or invalid app token.', cors);
  }

  if (!isJsonContentType(request.headers.get('Content-Type'))) {
    return errorResponse(415, 'unsupported_media_type', 'Send Content-Type: application/json.', cors);
  }
  const read = await readBodyCapped(request, MAX_BODY_BYTES);
  if ('error' in read) {
    return read.error === 'too_large'
      ? errorResponse(413, 'too_large', `Request body is over ${MAX_BODY_BYTES} bytes.`, cors)
      : errorResponse(400, 'invalid_json', 'Request body is not valid UTF-8 JSON.', cors);
  }
  let input: unknown;
  try {
    input = JSON.parse(read.text);
  } catch {
    return errorResponse(400, 'invalid_json', 'Request body is not valid JSON.', cors);
  }
  const built = buildUpstreamBody(input);
  if ('error' in built) return errorResponse(400, 'invalid_request', built.error, cors);

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify(built.body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    console.error(timedOut ? 'ai-proxy: upstream timed out' : 'ai-proxy: upstream unreachable');
    return timedOut
      ? errorResponse(504, 'upstream_timeout', 'The AI provider took too long to answer.', cors)
      : errorResponse(502, 'upstream_unreachable', 'Could not reach the AI provider.', cors);
  }

  // Groq rejecting OUR key must not look like the app sent a bad token (401).
  if (upstream.status === 401 || upstream.status === 403) {
    console.error(`ai-proxy: Groq rejected the server key (HTTP ${upstream.status})`);
    await upstream.body?.cancel().catch(() => {});
    return errorResponse(502, 'upstream_auth', 'The AI provider rejected the proxy credentials.', cors);
  }

  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    ...cors,
    'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
  };
  const retryAfter = upstream.headers.get('Retry-After');
  if (retryAfter) headers['Retry-After'] = retryAfter;
  return new Response(upstream.body, { status: upstream.status, headers });
}

