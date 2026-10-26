// AI mode: natural-language request → parsed items → live store search per item
// → LLM picks one search result per item → validated picks for the basket.
// The LLM never invents products: it can only point at refs of rows the app
// fetched itself, and every field it returns is re-validated (utils/aiBasket).
import { api, UnifiedProduct } from './api';
import { isAddressSyncing, waitForAddressSync } from './addressSync';
import { groqJson, GroqError, GroqJsonRequest } from './groq';
import type { AiProxyConfig } from './aiProxy';
import {
  AiPick,
  AiRequestedItem,
  AiUnmatched,
  MAX_INPUT_CHARS,
  PARSE_SCHEMA,
  PARSE_SYSTEM_PROMPT,
  PICK_SCHEMA,
  PICK_SYSTEM_PROMPT,
  attachTwins,
  buildCandidates,
  buildPickPrompt,
  cleanText,
  sanitizePicks,
  sanitizeRequestedItems,
} from '../utils/aiBasket';

export type AiProgress =
  | { stage: 'parsing' }
  | { stage: 'searching'; done: number; total: number; current: string }
  | { stage: 'choosing' };

export interface AiBasketResult {
  requested: AiRequestedItem[];
  picks: AiPick[];
  unmatched: AiUnmatched[];
}

export interface AiBasketDeps {
  /** AI proxy endpoint and app token (aiProxy.get()); null when not configured. */
  proxy: AiProxyConfig | null;
  /** Searches every store for one query; failures should resolve to []. */
  search: (query: string) => Promise<UnifiedProduct[]>;
  onProgress?: (progress: AiProgress) => void;
  signal?: AbortSignal;
  /** Injected in tests; defaults to the Groq client. */
  chat?: (req: GroqJsonRequest) => Promise<unknown>;
}

export class AiModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiModeError';
  }
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new GroqError('Cancelled', 'aborted');
};

export async function buildAiBasket(text: string, deps: AiBasketDeps): Promise<AiBasketResult> {
  const chat = deps.chat ?? groqJson;
  const input = cleanText(text, MAX_INPUT_CHARS);
  if (!input) throw new AiModeError('Type what you need first.');
  const proxy = deps.proxy;
  if (!proxy?.url || !proxy.token) {
    throw new AiModeError('AI mode is not configured (set EXPO_PUBLIC_AI_PROXY_URL and EXPO_PUBLIC_AI_PROXY_TOKEN in .env.local).');
  }

  deps.onProgress?.({ stage: 'parsing' });
  const parsed = await chat({
    proxy,
    system: PARSE_SYSTEM_PROMPT,
    user: input,
    schemaName: 'grocery_request',
    schema: PARSE_SCHEMA,
    signal: deps.signal,
  });
  const requested = sanitizeRequestedItems(parsed);
  if (requested.length === 0) throw new AiModeError('No grocery items found in that request. Try naming the products you need.');

  // One item at a time: the stores rate-limit bursts (Blinkit bridged searches
  // are serialized anyway), and progress stays readable.
  const results: UnifiedProduct[][] = [];
  for (let i = 0; i < requested.length; i++) {
    throwIfAborted(deps.signal);
    deps.onProgress?.({ stage: 'searching', done: i, total: requested.length, current: requested[i].name });
    try {
      const rows = await deps.search(requested[i].query);
      results.push(Array.isArray(rows) ? rows : []);
    } catch {
      results.push([]);
    }
  }
  throwIfAborted(deps.signal);

  const { candidates, reasons } = buildCandidates(results);
  let rawPicks: unknown = { picks: [] };
  if (candidates.some(c => c.length > 0)) {
    deps.onProgress?.({ stage: 'choosing' });
    rawPicks = await chat({
      proxy,
      system: PICK_SYSTEM_PROMPT,
      user: buildPickPrompt(requested, candidates),
      schemaName: 'basket_picks',
      schema: PICK_SCHEMA,
      signal: deps.signal,
    });
  }
  const { picks, unmatched } = sanitizePicks(rawPicks, requested, candidates, reasons);
  return {
    requested,
    picks: picks.map(p => ({ ...p, product: attachTwins(p.product, results[p.index]) })),
    unmatched,
  };
}

/** Live store search used by the app: waits out an address sync like the search screen does. */
export async function searchAllStores(query: string): Promise<UnifiedProduct[]> {
  if (isAddressSyncing()) await waitForAddressSync();
  try {
    return await api.search(query);
  } catch {
    return [];
  }
}
