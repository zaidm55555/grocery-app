// AI mode: natural-language request → parsed items → live store search per item
// → LLM picks one search result per item → validated picks for the basket →
// each pick's twin on the other store, from the item's results or a query ladder.
// The LLM never invents products: it can only point at refs of rows the app
// fetched itself, and every field it returns is re-validated (utils/aiBasket).
import { api, UnifiedProduct } from './api';
import { isAddressSyncing, waitForAddressSync } from './addressSync';
import { groqJson, GroqError, GroqJsonRequest } from './groq';
import { searchForMatch, MatchSearchOptions, MatchSearchResult } from './matchSearch';
import type { AiProxyConfig } from './aiProxy';
import type { Platform } from './storage';
import {
  AiPick,
  AiRequestedItem,
  AiUnlinked,
  AiUnmatched,
  MAX_INPUT_CHARS,
  MAX_TWIN_SEARCHES,
  PARSE_SCHEMA,
  PARSE_SYSTEM_PROMPT,
  PICK_SCHEMA,
  PICK_SYSTEM_PROMPT,
  TWIN_RUNGS,
  answeringPlatforms,
  attachTwins,
  buildCandidates,
  buildPickPrompt,
  cleanText,
  isUsableResult,
  missingTwinPlatforms,
  poolFor,
  sanitizePicks,
  sanitizeRequestedItems,
  twinTarget,
  withTwin,
} from '../utils/aiBasket';

export type AiProgress =
  | { stage: 'parsing' }
  | { stage: 'searching'; done: number; total: number; current: string }
  | { stage: 'choosing' }
  | { stage: 'linking'; done: number; total: number; current: string; platform: Platform };

export interface AiBasketResult {
  requested: AiRequestedItem[];
  /** Picks, each with the twins found on the other store(s) attached as platform prices. */
  picks: AiPick[];
  unmatched: AiUnmatched[];
  /** Picks left without a twin on a store that answered the searches, with the closest listing. */
  unlinked: AiUnlinked[];
}

export type TwinSearch = (
  platform: Platform,
  target: { name: string; unit: string; price: number },
  opts: MatchSearchOptions,
) => Promise<MatchSearchResult>;

export interface AiBasketDeps {
  /** AI proxy endpoint and app token (aiProxy.get()); null when not configured. */
  proxy: AiProxyConfig | null;
  /** Searches every store for one query; failures should resolve to []. */
  search: (query: string) => Promise<UnifiedProduct[]>;
  onProgress?: (progress: AiProgress) => void;
  signal?: AbortSignal;
  /** Injected in tests; defaults to the Groq client. */
  chat?: (req: GroqJsonRequest) => Promise<unknown>;
  /** Query-ladder search for a pick's twin on one store; defaults to searchForMatch. */
  findTwin?: TwinSearch;
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
  const fromPool = picks.map(p => ({ ...p, product: attachTwins(p.product, results[p.index]) }));
  const linked = await linkMissingTwins(fromPool, results, deps);
  return { requested, picks: linked.picks, unmatched, unlinked: linked.unlinked };
}

/**
 * For each pick still missing its twin on a store that answered the item
 * searches, walks the match query ladder on that store (seeded with the item's
 * own results), one store search at a time, and attaches an 'auto' twin. At most
 * MAX_TWIN_SEARCHES searches in all and TWIN_RUNGS per twin; what stays unlinked
 * is reported with the closest listing. 'suggest' twins are never attached here.
 */
async function linkMissingTwins(
  picks: AiPick[],
  results: UnifiedProduct[][],
  deps: AiBasketDeps,
): Promise<{ picks: AiPick[]; unlinked: AiUnlinked[] }> {
  const findTwin = deps.findTwin ?? searchTwin;
  const answering = answeringPlatforms(results);
  const jobs = picks.flatMap((pick, at) =>
    missingTwinPlatforms(pick.product).filter(pl => answering.has(pl)).map(platform => ({ at, platform })));
  const out = picks.slice();
  const unlinked: AiUnlinked[] = [];
  let budget = MAX_TWIN_SEARCHES;

  for (let j = 0; j < jobs.length; j++) {
    const { at, platform } = jobs[j];
    const pick = out[at];
    const base = { index: pick.index, item: pick.item, product: pick.product, platform };
    if (budget <= 0) {
      unlinked.push({ ...base, reason: 'Not searched: search limit reached', suggestion: null });
      continue;
    }
    throwIfAborted(deps.signal);
    deps.onProgress?.({ stage: 'linking', done: j, total: jobs.length, current: pick.item.name, platform });
    let found: MatchSearchResult;
    try {
      found = await findTwin(platform, twinTarget(pick.product), {
        seed: poolFor(results[pick.index], platform),
        maxQueries: Math.min(TWIN_RUNGS, budget),
        signal: deps.signal,
      });
    } catch (e: any) {
      budget -= 1;
      unlinked.push({ ...base, reason: `Search failed${e?.message ? `: ${cleanText(e.message, 80)}` : ''}`, suggestion: null });
      continue;
    }
    budget -= Math.max(1, found.searches);
    const { band, best, reasons } = found.decision;
    if (band === 'auto' && best && isUsableResult(best.candidate)) {
      out[at] = { ...pick, product: withTwin(pick.product, platform, best.candidate) };
    } else {
      unlinked.push({
        ...base,
        reason: band === 'auto' ? 'Same product found but not available' : reasons.join('; ') || 'No similar product',
        suggestion: band === 'suggest' && best ? { product: best.candidate, score: best.score, reasons } : null,
      });
    }
  }
  throwIfAborted(deps.signal);
  return { picks: out, unlinked };
}

// Twin search for the app: waits out an address sync like the item searches do.
async function searchTwin(...args: Parameters<TwinSearch>): Promise<MatchSearchResult> {
  if (isAddressSyncing()) await waitForAddressSync();
  return searchForMatch(...args);
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
