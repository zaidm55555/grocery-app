// AI mode: natural-language request → parsed items → live store search per item
// → LLM picks one search result per item → validated picks for the basket.
// The LLM never invents products: it can only point at refs of rows the app
// fetched itself, and every field it returns is re-validated (utils/aiBasket).
import { api, UnifiedProduct, PlatformVariant } from './api';
import { isAddressSyncing, waitForAddressSync } from './addressSync';
import { groqJson, GroqError, GroqJsonRequest } from './groq';
import type { AiProxyConfig } from './aiProxy';
import { Platform } from './storage';
import { PLATFORM_ORDER } from '../constants/theme';
import { aiPickBestMatch, aiBatchPickBestMatches, AiBatchMatchRequestItem } from './aiMatcher';
import { stripSizeToken } from '../utils/productKey';
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
  productToVariant,
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

  // 1. Run deterministic rule-based matching on all picks first
  const enhancedPicks = picks.map(p => ({
    ...p,
    product: attachTwins(p.product, results[p.index] || []),
  }));

  // 2. Identify missing platforms across all picks
  interface PendingTwin {
    pickIdx: number;
    platform: Platform;
    candidates: UnifiedProduct[];
  }
  const pendingTwins: PendingTwin[] = [];

  for (let pickIdx = 0; pickIdx < enhancedPicks.length; pickIdx++) {
    const p = enhancedPicks[pickIdx];
    const prices = p.product.platformPrices || {};

    for (const platform of PLATFORM_ORDER) {
      if (platform === p.product.platform || prices[platform]) continue;

      let candidatePool = (results[p.index] || []).filter(
        item => isObj(item) && item.platform === platform && typeof item.id === 'string'
      );

      // If pool didn't have results for this store, fetch single-store candidates
      if (candidatePool.length === 0) {
        try {
          const query = stripSizeToken(p.product.title) || p.product.title;
          candidatePool = await api.searchSingle(platform, query);
        } catch {
          candidatePool = [];
        }
      }

      if (candidatePool.length > 0) {
        pendingTwins.push({
          pickIdx,
          platform,
          candidates: candidatePool,
        });
      }
    }
  }

  // 3. If any picks have missing store twins, match ALL of them in a SINGLE Groq batch request!
  if (pendingTwins.length > 0) {
    const batchItems: AiBatchMatchRequestItem[] = pendingTwins.map((pt, idx) => {
      const p = enhancedPicks[pt.pickIdx];
      return {
        itemIndex: idx,
        target: {
          name: p.product.title,
          brand: p.product.brand,
          unit: p.product.quantity,
          price: p.product.price,
          mrp: p.product.originalPrice,
          platform: p.product.platform,
        },
        candidates: pt.candidates.slice(0, 10),
        targetPlatform: pt.platform,
      };
    });

    console.log(`[AiBasket] Batching AI twin matching for ${batchItems.length} missing store products into a single Groq request...`);

    try {
      const decisions = await aiBatchPickBestMatches({
        items: batchItems,
        deps: {
          proxy,
          chat: deps.chat,
          signal: deps.signal,
        },
      });

      for (let idx = 0; idx < pendingTwins.length; idx++) {
        const pt = pendingTwins[idx];
        const decision = decisions.get(idx);
        if (decision?.matchFound && decision.candidateIndex !== null && pt.candidates[decision.candidateIndex]) {
          const match = pt.candidates[decision.candidateIndex];
          const p = enhancedPicks[pt.pickIdx];
          p.product = {
            ...p.product,
            platformPrices: {
              ...(p.product.platformPrices || {}),
              [pt.platform]: productToVariant(match),
            },
          };
          console.log(`[AiBasket] Groq AI batch auto-matched twin on ${pt.platform} for "${p.product.title}": "${match.title}" (${decision.reason})`);
        }
      }
    } catch (e) {
      console.warn('[AiBasket] Error in Groq AI batch matching:', e);
    }
  }

  return {
    requested,
    picks: enhancedPicks,
    unmatched,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Attaches the same product's listing on the other store(s) as a platform price.
 * Runs deterministic rule matching first, then falls back to Groq AI matching when no rule match is found.
 */
export async function attachTwinsWithAi(
  product: UnifiedProduct,
  pool: UnifiedProduct[],
  deps?: {
    proxy?: AiProxyConfig | null;
    chat?: (req: GroqJsonRequest) => Promise<unknown>;
    signal?: AbortSignal;
  }
): Promise<UnifiedProduct> {
  // 1. Try deterministic rule matcher first
  const withTwins = attachTwins(product, pool);
  const prices: Partial<Record<Platform, PlatformVariant>> = { ...(withTwins.platformPrices || {}) };
  let changed = false;

  // 2. Fall back to Groq AI auto-matcher for any other store not matched by rules
  for (const platform of PLATFORM_ORDER) {
    if (platform === product.platform || prices[platform]) continue;

    let candidates = (pool || []).filter(p => isObj(p) && p.platform === platform && typeof p.id === 'string');

    // If candidate pool didn't have results for this store, fetch candidates directly
    if (candidates.length === 0) {
      try {
        const query = stripSizeToken(product.title) || product.title;
        candidates = await api.searchSingle(platform, query);
      } catch {
        candidates = [];
      }
    }

    if (candidates.length === 0) continue;

    console.log(`[AiBasket] Rule-based twin match found no match for "${product.title}" on ${platform}. Calling Groq AI fallback with ${candidates.length} candidates...`);

    try {
      const decision = await aiPickBestMatch({
        target: {
          name: product.title,
          brand: product.brand,
          unit: product.quantity,
          price: product.price,
          mrp: product.originalPrice,
          platform: product.platform,
        },
        candidates: candidates.slice(0, 12),
        targetPlatform: platform,
        deps: {
          proxy: deps?.proxy,
          chat: deps?.chat,
          signal: deps?.signal,
        },
      });

      if (decision?.matchFound && decision.candidateIndex !== null && candidates[decision.candidateIndex]) {
        const match = candidates[decision.candidateIndex];
        prices[platform] = productToVariant(match);
        changed = true;
        console.log(`[AiBasket] Groq AI auto-matched twin on ${platform}: "${match.title}" (${decision.reason})`);
      }
    } catch (e) {
      console.warn(`[AiBasket] Error in Groq AI twin matching on ${platform}:`, e);
    }
  }

  return changed ? { ...withTwins, platformPrices: prices } : withTwins;
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
