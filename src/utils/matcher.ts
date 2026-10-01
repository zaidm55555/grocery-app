// Originally ported from the Grocery Order Optimizer (src/utils/matcher.js); since extended with token
// normalization, variant-conflict detection and unit-aware size/price scoring.
// Weights: base-name 0.6, pack size 0.25, price sanity 0.15. A name mismatch
// (score 0 on the name term) kills the match.
import { itemName, itemUnit, stripSizeToken, variantSize } from './productKey';

const MATCH_THRESHOLD = 0.5;
// Top pick is flagged ambiguous when the runner-up scores within this margin.
const AMBIGUOUS_MARGIN = 0.05;
// Below this name similarity a candidate is never a match, whatever its size/price.
const MIN_NAME_SIMILARITY = 0.55;
// Same-product check used to re-validate stored basket links.
const SAME_PRODUCT_NAME = 0.85;

// Accepts both match targets ({name, unit}) and UnifiedProduct rows ({title, quantity}).
export interface MatchableItem {
  name?: string;
  title?: string;
  unit?: string;
  quantity?: string;
  price?: number;
}

const STOPWORDS = new Set(['of', 'with', 'and', 'the', 'fresh', 'pack', 'pouch', 'bottle', 'packet', 'pkt', 'pc', 'pcs', 'combo']);

// Spelling / language variants collapsed to one canonical token.
const SYNONYMS: Record<string, string> = {
  dahi: 'curd', yoghurt: 'yogurt', yogourt: 'yogurt',
  chilli: 'chili', chillies: 'chili', chilies: 'chili', tomatoes: 'tomato', potatoes: 'potato',
  biscuits: 'biscuit', cookies: 'cookie', coriander: 'dhaniya', cilantro: 'dhaniya',
  capsicum: 'bellpepper', paneer: 'cottagecheese', ghee: 'clarifiedbutter',
};

// Mutually exclusive variant words: a candidate carrying a *different* member
// of a group than the target is a different product, regardless of other overlap.
const CONFLICT_GROUPS: string[][] = [
  ['salted', 'unsalted'],
  ['toned', 'full', 'double', 'skimmed', 'slim'],
  ['diet', 'zero', 'regular', 'sugarfree'],
  ['sweet', 'unsweetened', 'sweetened'],
  ['white', 'brown', 'black', 'red', 'green', 'yellow'],
  ['mild', 'spicy', 'hot'],
  ['original', 'chocolate', 'vanilla', 'strawberry', 'mango', 'butterscotch'],
  ['small', 'medium', 'large'],
];

function normalizeToken(t: string): string {
  if (SYNONYMS[t]) return SYNONYMS[t];
  if (t.length > 3 && t.endsWith('ies')) t = t.slice(0, -3) + 'y';
  else if (t.length > 4 && t.endsWith('oes')) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  return SYNONYMS[t] || t;
}

// Ordered, normalized, stopword-free tokens (order kept so the leading token,
// usually the brand, can be weighted).
export function nameTokens(str: string | undefined): string[] {
  const out: string[] = [];
  String(str || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).forEach(raw => {
    if (STOPWORDS.has(raw)) return;
    const t = normalizeToken(raw);
    if (!out.includes(t)) out.push(t);
  });
  return out;
}

export function tokenSet(str: string | undefined): Set<string> {
  return new Set(nameTokens(str));
}

// Qualifier words that define a distinct product when only one side has them
// ("Coca-Cola" vs "Coca-Cola Zero").
const QUALIFIERS = ['zero', 'diet', 'sugarfree', 'unsalted', 'lite', 'light', 'decaf'];

function hasVariantConflict(ta: Set<string>, tb: Set<string>): boolean {
  if (QUALIFIERS.some(q => ta.has(q)) !== QUALIFIERS.some(q => tb.has(q))) return true;
  return CONFLICT_GROUPS.some(group => {
    const ga = group.filter(w => ta.has(w));
    const gb = group.filter(w => tb.has(w));
    return ga.length > 0 && gb.length > 0 && !ga.some(w => gb.includes(w));
  });
}

// Weighted Jaccard over the pack-size-stripped name tokens, so "Tata Salt
// 1 kg" and "Tata Salt 500 g" share the same base tokens. The leading token
// (usually the brand) counts extra; conflicting variant words zero the score.
export function nameSimilarity(a: string | undefined, b: string | undefined): number {
  const la = nameTokens(stripSizeToken(a));
  const lb = nameTokens(stripSizeToken(b));
  if (!la.length || !lb.length) return 0;
  const ta = new Set(la), tb = new Set(lb);
  if (hasVariantConflict(ta, tb)) return 0;
  const weighted = la.length > 1 && lb.length > 1;
  const w = (t: string, list: string[]) => (weighted && list[0] === t ? 2.5 : 1);
  let shared = 0, total = 0;
  const all = new Set([...la, ...lb]);
  all.forEach(t => {
    const wa = ta.has(t) ? w(t, la) : 0;
    const wb = tb.has(t) ? w(t, lb) : 0;
    shared += Math.min(wa, wb);
    total += Math.max(wa, wb);
  });
  let sim = total ? shared / total : 0;
  // Different leading token on both sides = different brand ("Tata Salt" vs "Aashirvaad Salt").
  if (weighted && !tb.has(la[0]) && !ta.has(lb[0])) sim *= 0.5;
  // Each side carries words the other lacks ("Pav Bread" vs "Milk Bread"): that
  // is two different products, not one listing with extra wording.
  if (la.some(t => !tb.has(t)) && lb.some(t => !ta.has(t))) sim *= 0.75;
  return sim;
}

type SizeClass = 'weight' | 'volume' | 'count' | null;

function sizeClass(item: MatchableItem): SizeClass {
  const raw = String(itemUnit(item) || itemName(item)).toLowerCase();
  const m = raw.match(/\d\s*(kgs?|kilograms?|gms?|grams?|g|ml|millilitres?|litres?|liters?|l|pcs?|pieces?|count|units?)\b/);
  if (!m) return null;
  const u = m[1];
  if (/^(kg|kilo|g)/.test(u)) return 'weight';
  if (/^(ml|milli|l)/.test(u)) return 'volume';
  return 'count';
}

// Weight vs volume packs can never be the same product.
function sizeClassConflict(target: MatchableItem, candidate: MatchableItem): boolean {
  const ca = sizeClass(target), cb = sizeClass(candidate);
  return !!ca && !!cb && ca !== cb && ca !== 'count' && cb !== 'count';
}

// Pack-size compatibility in [0,1]. Same normalized size = 1; near-equal
// (±10%) = 0.9; ±25% = 0.6; whole-number multiple ≤4x (500g vs 1kg) = 0.5;
// different unit type (weight vs volume) or unrelated size = 0; unparseable = 0.4.
export function sizeScore(target: MatchableItem, candidate: MatchableItem): number {
  const a = variantSize(target);
  const b = variantSize(candidate);
  if (a === Infinity || b === Infinity) return 0.4;
  if (sizeClassConflict(target, candidate)) return 0;
  const ratio = Math.max(a, b) / Math.min(a, b);
  if (ratio === 1) return 1;
  if (ratio <= 1.1) return 0.9;
  if (ratio <= 1.25) return 0.6;
  if (ratio <= 4 && Number.isInteger(ratio)) return 0.5;
  return 0;
}

function priceSanity(target: MatchableItem, candidate: MatchableItem, size: number): number {
  const a = Number(target.price) || 0;
  const b = Number(candidate.price) || 0;
  if (!a || !b) return 1;
  const sa = variantSize(target), sb = variantSize(candidate);
  if (size > 0 && sa !== Infinity && sb !== Infinity) {
    // Compare price per unit of pack size so 500g@₹60 vs 1kg@₹110 is judged fairly.
    const ua = a / sa, ub = b / sb;
    const unitRatio = Math.max(ua, ub) / Math.min(ua, ub);
    return unitRatio <= 1.5 ? 1 : unitRatio <= 2.5 ? 0.6 : 0.3;
  }
  const ratio = Math.max(a, b) / Math.min(a, b);
  return ratio <= 4 ? 1 : 0.5;
}

export function matchScore(target: MatchableItem, candidate: MatchableItem): number {
  const name = nameSimilarity(itemName(target), itemName(candidate));
  if (name < MIN_NAME_SIMILARITY || sizeClassConflict(target, candidate)) return 0;
  const size = sizeScore(target, candidate);
  const price = priceSanity(target, candidate, size);
  return Math.round((name * 0.6 + size * 0.25 + price * 0.15) * 1000) / 1000;
}

// Strict identity check (not a ranking): is `candidate` the same product as
// `target`, allowing only wording/spelling differences and ~equal pack size?
export function isSameProduct(target: MatchableItem, candidate: MatchableItem): boolean {
  if (sizeClassConflict(target, candidate)) return false;
  return nameSimilarity(itemName(target), itemName(candidate)) >= SAME_PRODUCT_NAME && sizeScore(target, candidate) >= 0.9;
}

interface BestMatch<T extends MatchableItem> {
  candidate: T;
  score: number;
  // True when the runner-up scored within AMBIGUOUS_MARGIN of the winner and
  // the callers may want the user to confirm the pick.
  ambiguous: boolean;
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
  let runnerUp = 0;
  for (const c of candidates || []) {
    const s = matchScore(target, c);
    if (s > bestScore || (best && s === bestScore && closer(c, best))) {
      runnerUp = Math.max(runnerUp, bestScore);
      bestScore = s;
      best = c;
    } else if (s > runnerUp) {
      runnerUp = s;
    }
  }
  if (!best || bestScore < MATCH_THRESHOLD) return null;
  return { candidate: best, score: bestScore, ambiguous: bestScore - runnerUp <= AMBIGUOUS_MARGIN && runnerUp >= MATCH_THRESHOLD };
}
