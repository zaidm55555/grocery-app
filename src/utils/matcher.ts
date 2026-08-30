// Ported verbatim from the Grocery Order Optimizer (src/utils/matcher.js).
// Weights: base-name 0.6, pack size 0.25, price sanity 0.15. A name mismatch
// (score 0 on the name term) kills the match.
import { itemName, stripSizeToken, variantSize } from './productKey';

const MATCH_THRESHOLD = 0.4;

// Accepts both match targets ({name, unit}) and UnifiedProduct rows ({title, quantity}).
export interface MatchableItem {
  name?: string;
  title?: string;
  unit?: string;
  quantity?: string;
  price?: number;
}

export function tokenSet(str: string | undefined): Set<string> {
  return new Set(String(str || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

// Jaccard similarity over the pack-size-stripped name tokens, so "Tata Salt
// 1 kg" and "Tata Salt 500 g" share the same base tokens.
export function nameSimilarity(a: string | undefined, b: string | undefined): number {
  const ta = tokenSet(stripSizeToken(a));
  const tb = tokenSet(stripSizeToken(b));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  ta.forEach(t => { if (tb.has(t)) shared++; });
  return shared / Math.max(ta.size, tb.size);
}

// Pack-size compatibility in [0,1]. Same normalized size = 1; whole-number
// multiple ≤4x (500g vs 1kg) = 0.5; unrelated sizes = 0; unparseable = 0.5 neutral.
export function sizeScore(target: MatchableItem, candidate: MatchableItem): number {
  const a = variantSize(target);
  const b = variantSize(candidate);
  if (a === Infinity || b === Infinity) return 0.5;
  const ratio = Math.max(a, b) / Math.min(a, b);
  if (ratio === 1) return 1;
  if (ratio <= 4 && Number.isInteger(ratio)) return 0.5;
  return 0;
}

function priceSanity(target: MatchableItem, candidate: MatchableItem, size: number): number {
  const a = Number(target.price) || 0;
  const b = Number(candidate.price) || 0;
  if (!a || !b) return 1;
  const ratio = Math.max(a, b) / Math.min(a, b);
  if (size >= 1) return ratio <= 2 ? 1 : 0.3; // same size → price must be close
  return ratio <= 4 ? 1 : 0.5;                // different size → wider gap OK
}

export function matchScore(target: MatchableItem, candidate: MatchableItem): number {
  const name = nameSimilarity(itemName(target), itemName(candidate));
  if (name === 0) return 0;
  const size = sizeScore(target, candidate);
  const price = priceSanity(target, candidate, size);
  return Math.round((name * 0.6 + size * 0.25 + price * 0.15) * 1000) / 1000;
}

interface BestMatch<T extends MatchableItem> {
  candidate: T;
  score: number;
}

export function pickBestMatch<T extends MatchableItem>(target: MatchableItem, candidates: T[] | null | undefined): BestMatch<T> | null {
  let best: T | null = null;
  let bestScore = 0;
  const tSize = variantSize(target);
  const tPrice = Number(target.price) || 0;
  // Ties broken by: closest pack size, then closest price
  // ("500 ml @ ₹24" beats "500 ml x 2 @ ₹48").
  const tieRank = (c: T): number[] => [
    variantSize(c) === Infinity ? Infinity : Math.abs(variantSize(c) - tSize),
    Math.abs((Number(c.price) || 0) - tPrice),
  ];
  const closer = (a: T, b: T): boolean => {
    const ra = tieRank(a), rb = tieRank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i];
    return false;
  };
  for (const c of candidates || []) {
    const s = matchScore(target, c);
    if (s > bestScore || (best && s === bestScore && closer(c, best))) { bestScore = s; best = c; }
  }
  if (!best || bestScore < MATCH_THRESHOLD) return null;
  return { candidate: best, score: bestScore };
}
