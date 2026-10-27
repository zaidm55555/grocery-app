// Finds a basket line's twin on another store for the match flow and AI mode.
//
// One search with the full source title often misses the twin (stores word
// titles differently), so this walks a query ladder - full title, title without
// sizes/descriptors, brand + first product words, head noun - pooling the
// results, and stops as soon as a candidate scores high enough to auto-link.
import { api, UnifiedProduct } from './api';
import { Platform } from './storage';
import { AUTO_MIN, buildQueryLadder, decideMatch, MatchableItem, MatchDecision } from '../utils/matcher';

/** Results kept per query, and in the pool overall. */
export const PER_QUERY = 20;
export const MAX_POOL = 30;

export interface MatchSearchOptions {
  /** This store's listings already in hand (AI mode's own search): ranked with the rest, not re-fetched. */
  seed?: UnifiedProduct[];
  /** Most store searches to run (default: the whole ladder). */
  maxQueries?: number;
  /** Stops between rungs once aborted. */
  signal?: AbortSignal;
}

export interface MatchSearchResult {
  decision: MatchDecision<UnifiedProduct>;
  /** Every pooled candidate, best first. */
  candidates: UnifiedProduct[];
  /** Queries that answered, in order. */
  queries: string[];
  /** Store searches attempted, failed ones included. */
  searches: number;
}

const keyOf = (p: UnifiedProduct) => p.id || `${p.title}|${p.quantity}`;

/**
 * Throws when the first search fails and nothing is pooled yet (network/session
 * trouble: the cell shows an error with Retry); a later rung failing just ends
 * the ladder early.
 */
export async function searchForMatch(
  platform: Platform,
  target: MatchableItem & { name: string },
  opts: MatchSearchOptions = {},
): Promise<MatchSearchResult> {
  const pool: UnifiedProduct[] = [];
  const seen = new Set<string>();
  const queries: string[] = [];
  let searches = 0;
  const take = (r: UnifiedProduct) => {
    const k = keyOf(r);
    if (seen.has(k)) return false;
    seen.add(k);
    pool.push(r);
    return true;
  };
  (opts.seed || []).forEach(take);
  const cap = pool.length + MAX_POOL;
  let decision = decideMatch<UnifiedProduct>(target, pool);

  for (const q of buildQueryLadder(target.name).slice(0, opts.maxQueries ?? Infinity)) {
    if (opts.signal?.aborted) break;
    let results: UnifiedProduct[];
    searches++;
    try {
      results = await api.searchSingle(platform, q, { throwOnError: true, includeOutOfStock: true });
    } catch (e) {
      if (pool.length === 0) throw e;
      break;
    }
    queries.push(q);
    for (const r of (results || []).slice(0, PER_QUERY)) {
      if (pool.length >= cap) break;
      take(r);
    }
    decision = decideMatch<UnifiedProduct>(target, pool);
    // Good enough: an exact-size, fully explained candidate. (A close second
    // listing keeps it at 'suggest', but more searches won't change that.)
    const best = decision.best;
    if (decision.band === 'auto' || (best && best.autoEligible && best.score >= AUTO_MIN)) break;
  }

  return { decision, candidates: decision.ranked.map(r => r.candidate), queries, searches };
}
