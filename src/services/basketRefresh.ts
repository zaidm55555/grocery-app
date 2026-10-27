// Re-validates a saved basket against the live Swiggy/Blinkit catalogs.
//
// Basket lines persist a snapshot of each listing (price, stock, catalog ids).
// Days later that snapshot is stale, and a link made by an older/looser matcher
// may pair two different products ("Pav Bread" ↔ "Milk Bread"). This refreshes
// every line from live search results, keyed by catalog id first and a strict
// same-product check second, and never relinks a line to a different product:
// when a listing can't be found it is flagged unavailable instead.
import { api, UnifiedProduct, PlatformVariant, CartCalculation, getProductPlatformLimit } from './api';
import { Platform } from './storage';
import { scoreMatch, pickBestMatch, isSameProduct, decideMatch, brandNote, SUGGEST_MIN } from '../utils/matcher';
import { stripSizeToken } from '../utils/productKey';
import { needsRefresh } from '../utils/lineFreshness';

type Line = { product: UnifiedProduct; quantity: number };

const POOL = 5;
// A stored (non-manual) link stays while it is at least a plausible match;
// one the matcher now rejects outright (other brand/variant/size class) is
// replaced. Replacements are only made from an 'auto'-band match.
const LINK_MIN_SCORE = SUGGEST_MIN;

type IdBearer = { id?: string; productId?: string; originalId?: string; spinId?: string };
const clean = (xs: (string | undefined)[]) => xs.filter(Boolean).map(String);

// Ids that pin ONE pack size. Instamart's productId is shared by every pack
// size of a product (100 g, 3 x 100 g, ...), so it must never decide alone.
const variantIdsOf = (v: IdBearer): string[] => clean([v.originalId, v.spinId, v.id?.replace(/^(blinkit|swiggy)-/, '')]);

async function searchLive(platform: Platform, title: string): Promise<UnifiedProduct[]> {
  const queries = [title];
  const stripped = stripSizeToken(title);
  if (stripped && stripped !== title) queries.push(stripped);
  for (const q of queries) {
    const results = await api.searchSingle(platform, q);
    if (results.length > 0) return results;
  }
  return [];
}

const toVariant = (live: UnifiedProduct): PlatformVariant => ({
  id: live.id,
  title: live.title,
  brand: live.brand,
  quantity: live.quantity,
  price: live.price,
  originalPrice: live.originalPrice,
  imageUrl: live.imageUrl,
  originalId: live.originalId,
  productId: live.productId,
  spinId: live.spinId,
  storeId: live.storeId,
  inStock: live.inStock,
  availableStock: live.availableStock,
  maxQuantity: live.maxQuantity,
  storeVerified: live.storeVerified,
});

const unavailable = <T extends PlatformVariant | UnifiedProduct>(v: T): T => ({ ...v, inStock: false, availableStock: 0 });

// Live listing for a stored one: same catalog id, else strictly the same product.
function findLive(stored: PlatformVariant | UnifiedProduct, candidates: UnifiedProduct[]): UnifiedProduct | null {
  const ids = variantIdsOf(stored);
  const byId = candidates.find(c => variantIdsOf(c).some(i => ids.includes(i)));
  if (byId) return byId;
  const target = { name: stored.title, unit: stored.quantity, price: stored.price };
  const same = candidates.filter(c => isSameProduct(target, { name: c.title, unit: c.quantity }));
  return pickBestMatch(target, same)?.candidate ?? null;
}

async function refreshLine(line: Line): Promise<Line> {
  const src = line.product;
  let product: UnifiedProduct = src;
  const prices: Partial<Record<Platform, PlatformVariant>> = { ...(src.platformPrices || {}) };

  // Source listing
  const srcCands = await searchLive(src.platform, src.title);
  if (srcCands.length > 0) {
    const live = findLive(src, srcCands);
    product = live
      ? { ...src, ...toVariant(live), platform: src.platform, platformPrices: src.platformPrices }
      : unavailable(src);
  }

  // Linked listings on the other platforms
  for (const pl of Object.keys(prices) as Platform[]) {
    const stored = prices[pl]!;
    // A link the user picked by hand is kept however weakly it scores — it is
    // usually the very reason auto-match found nothing.
    const link = scoreMatch({ name: src.title, unit: src.quantity, price: src.price }, { name: stored.title, unit: stored.quantity, price: stored.price });
    const linkValid = stored.manual || (!link.rejected && link.score >= LINK_MIN_SCORE);

    if (linkValid) {
      const cands = await searchLive(pl, stored.title);
      if (cands.length === 0) continue; // search gave nothing — keep what we have
      const live = findLive(stored, cands);
      prices[pl] = live
        ? { ...toVariant(live), ...(stored.manual ? { manual: true } : {}), ...(stored.matchNote ? { matchNote: stored.matchNote } : {}) }
        : unavailable(stored);
    } else {
      // Bad link from an older matcher: replace with a proper match for the
      // SOURCE product, or drop the link rather than keep a different product.
      const cands = await searchLive(pl, src.title);
      const decision = decideMatch({ name: src.title, unit: src.quantity, price: src.price }, cands);
      if (decision.band === 'auto' && decision.best) {
        const note = brandNote(decision.best);
        prices[pl] = { ...toVariant(decision.best.candidate), ...(note ? { matchNote: note } : {}) };
      }
      else if (cands.length > 0) delete prices[pl];
    }
  }

  return {
    ...line,
    product: {
      ...product,
      platformPrices: Object.keys(prices).length > 0 ? prices : undefined,
      refreshedAt: Date.now(),
    },
  };
}

// Lines added or re-checked through the right store stay trusted for an hour,
// the rest for 10 minutes (see utils/lineFreshness.ts).
export async function refreshBasketLines(items: Line[], force = false): Promise<{ items: Line[]; changed: boolean }> {
  const out = items.slice();
  const now = Date.now();
  const stale = items
    .map((ci, i) => ({ ci, i }))
    .filter(({ ci }) => force || needsRefresh(ci.product, now));

  for (let s = 0; s < stale.length; s += POOL) {
    await Promise.all(stale.slice(s, s + POOL).map(async ({ ci, i }) => {
      try {
        out[i] = await refreshLine(ci);
      } catch {
        // leave the line as stored
      }
    }));
  }
  return { items: out, changed: stale.length > 0 };
}

// Same data regardless of key order and unset fields, ignoring the refresh stamp.
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = (o: object) => Object.keys(o).filter(k => k !== 'refreshedAt' && (o as Record<string, unknown>)[k] !== undefined);
  const ka = keys(a);
  const kb = keys(b);
  return ka.length === kb.length && ka.every(k => sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Folds a background refresh (`before` → `after`, index for index) into the
 * basket as it is NOW, which may have moved on while the refresh ran: quantity
 * edits, lines removed, stock limits the live bill wrote. Only lines the refresh
 * touched change, and they keep their current quantity. `repriced` is true when
 * a line changed beyond its refresh stamp, i.e. the bill must be recomputed.
 */
export function mergeRefreshedLines(current: Line[], before: Line[], after: Line[]): { items: Line[]; changed: boolean; repriced: boolean } {
  let changed = false;
  let repriced = false;
  const used = new Set<number>();
  const items = current.map(line => {
    const i = before.findIndex((b, j) => !used.has(j) && b.product.id === line.product.id);
    if (i < 0) return line;
    used.add(i);
    const next = after[i];
    if (!next || next === before[i]) return line; // not re-checked (fresh, or its search failed)
    changed = true;
    if (sameData(next.product, before[i].product)) {
      // Nothing moved: keep the line as it is now and only record the check.
      return { ...line, product: { ...line.product, refreshedAt: next.product.refreshedAt } };
    }
    repriced = true;
    return { ...line, product: next.product };
  });
  return { items, changed, repriced };
}

// Writes the stock limits a live bill discovered back onto the saved lines.
// Blinkit search carries no stock, so the bill is the only place its real limit
// shows up; without persisting it, Search keeps allowing quantities the bill
// then clamps (and the basket flashes the stale limit before correcting).
export function applyLiveLimits(items: Line[], calcs: CartCalculation[]): { items: Line[]; changed: boolean } {
  let changed = false;
  const out = items.map(line => {
    let product = line.product;
    for (const calc of calcs) {
      const pl = calc.platform;
      const stored = getProductPlatformLimit(product, pl);
      const live = getProductPlatformLimit(product, pl, [calc]);
      if (live === undefined || live === stored) continue;
      const patch = { availableStock: live, ...(live <= 0 ? { inStock: false } : {}) };
      if (product.platform === pl) {
        product = { ...product, ...patch };
      } else if (product.platformPrices?.[pl]) {
        product = { ...product, platformPrices: { ...product.platformPrices, [pl]: { ...product.platformPrices[pl]!, ...patch } } };
      } else {
        continue;
      }
      changed = true;
    }
    return product === line.product ? line : { ...line, product };
  });
  return { items: out, changed };
}
