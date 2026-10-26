// Minimal Groq chat-completions client for AI mode. Requests go to BasketBuddy's
// AI proxy (backend/ai-proxy), which adds the Groq key server-side and forwards
// an allow-listed version of this OpenAI-style body to Groq; the app never sees
// the key. Plain fetch keeps the bundle free of SDKs and makes it easy to mock.
import type { AiProxyConfig } from './aiProxy';

// Production model with strict JSON-schema structured outputs on Groq
// (https://console.groq.com/docs/structured-outputs). Groq's recommended
// replacement for the deprecated Llama 3.x models. The proxy only allows this
// model: keep ALLOWED_MODELS in backend/ai-proxy/src/proxy.ts in sync.
export const GROQ_MODEL = 'openai/gpt-oss-120b';

const TIMEOUT_MS = 45000;

export type GroqErrorKind = 'auth' | 'rate_limit' | 'http' | 'network' | 'timeout' | 'bad_response' | 'aborted';

export class GroqError extends Error {
  kind: GroqErrorKind;
  status?: number;

  constructor(message: string, kind: GroqErrorKind, status?: number) {
    super(message);
    this.name = 'GroqError';
    this.kind = kind;
    this.status = status;
  }
}

export interface GroqJsonRequest {
  /** The AI proxy endpoint and app token (see aiProxy.ts). */
  proxy: AiProxyConfig;
  system: string;
  user: string;
  /** Name and JSON schema for strict structured output. */
  schemaName: string;
  schema: Record<string, unknown>;
  signal?: AbortSignal;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    const msg = isObj(body) && isObj(body.error) ? body.error.message : undefined;
    return typeof msg === 'string' ? msg.slice(0, 200) : '';
  } catch {
    return '';
  }
}

/**
 * One chat completion constrained to `schema`; resolves to the parsed JSON.
 * The result is still untrusted: callers must validate every field.
 */
export async function groqJson(req: GroqJsonRequest): Promise<unknown> {
  const doFetch = req.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (req.signal?.aborted) ctrl.abort();
  req.signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await doFetch(req.proxy.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-App-Token': req.proxy.token,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: req.schemaName, strict: true, schema: req.schema },
        },
        temperature: 0.2,
        // gpt-oss is a reasoning model: keep reasoning short (it is returned in a
        // separate `reasoning` field, so `content` holds only the JSON).
        reasoning_effort: 'low',
        max_completion_tokens: req.maxTokens ?? 4096,
      }),
      signal: ctrl.signal,
    });
  } catch {
    if (req.signal?.aborted) throw new GroqError('Cancelled', 'aborted');
    if (timedOut) throw new GroqError('The AI service took too long to answer. Try again.', 'timeout');
    throw new GroqError('Could not reach the AI service. Check your connection.', 'network');
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onAbort);
  }

  // 401/403/413 come from the proxy itself; 429 is its per-IP limit or Groq's
  // own. The proxy reports Groq rejecting its key as 502, never as 401.
  if (res.status === 401) {
    throw new GroqError('The AI service rejected this app. Check EXPO_PUBLIC_AI_PROXY_TOKEN.', 'auth', res.status);
  }
  if (res.status === 403) {
    throw new GroqError('The AI service refused requests from here (origin not allowed).', 'auth', res.status);
  }
  if (res.status === 429) {
    throw new GroqError('Too many AI requests. Wait a minute and try again.', 'rate_limit', res.status);
  }
  if (res.status === 413) {
    throw new GroqError('That request is too big for AI mode. Try fewer items.', 'http', res.status);
  }
  if (!res.ok) {
    const detail = await errorDetail(res);
    throw new GroqError(`AI request failed (${res.status})${detail ? `: ${detail}` : ''}`, 'http', res.status);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new GroqError('Groq sent an unreadable response.', 'bad_response', res.status);
  }
  const choice = isObj(data) && Array.isArray(data.choices) ? data.choices[0] : undefined;
  const content = isObj(choice) && isObj(choice.message) ? choice.message.content : undefined;
  if (isObj(choice) && choice.finish_reason === 'length') {
    throw new GroqError('The AI answer was cut off. Try a shorter request.', 'bad_response', res.status);
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new GroqError('Groq returned an empty answer.', 'bad_response', res.status);
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new GroqError('Groq returned malformed JSON.', 'bad_response', res.status);
  }
}
