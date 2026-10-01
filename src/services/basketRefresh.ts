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
import { matchScore, pickBestMatch, isSameProduct } from '../utils/matcher';
import { stripSizeToken } from '../utils/productKey';

type Line = { product: UnifiedProduct; quantity: number };

const REFRESH_TTL_MS = 10 * 60 * 1000;
const POOL = 5;
const LINK_MIN_SCORE = 0.5;

const idsOf = (v: { id?: string; productId?: string; originalId?: string }): string[] =>
  [v.productId, v.originalId, v.id?.replace(/^(blinkit|swiggy)-/, '')].filter(Boolean).map(String);

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
});

const unavailable = <T extends PlatformVariant | UnifiedProduct>(v: T): T => ({ ...v, inStock: false, availableStock: 0 });

// Live listing for a stored one: same catalog id, else strictly the same product.
function findLive(stored: PlatformVariant | UnifiedProduct, candidates: UnifiedProduct[]): UnifiedProduct | null {
  const ids = idsOf(stored);
  const byId = candidates.find(c => idsOf(c).some(i => ids.includes(i)));
  if (byId) return byId;
  const best = pickBestMatch({ name: stored.title, unit: stored.quantity, price: stored.price }, candidates);
  return best && isSameProduct({ name: stored.title, unit: stored.quantity }, { name: best.candidate.title, unit: best.candidate.quantity })
    ? best.candidate
    : null;
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
    const linkValid = matchScore({ name: src.title, unit: src.quantity, price: src.price }, { name: stored.title, unit: stored.quantity, price: stored.price }) >= LINK_MIN_SCORE;

    if (linkValid) {
      const cands = await searchLive(pl, stored.title);
      if (cands.length === 0) continue; // search gave nothing — keep what we have
      const live = findLive(stored, cands);
      prices[pl] = live ? toVariant(live) : unavailable(stored);
    } else {
      // Bad link from an older matcher: replace with a proper match for the
      // SOURCE product, or drop the link rather than keep a different product.
      const cands = await searchLive(pl, src.title);
      const best = pickBestMatch({ name: src.title, unit: src.quantity, price: src.price }, cands);
      if (best) prices[pl] = toVariant(best.candidate);
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

export async function refreshBasketLines(items: Line[], force = false): Promise<{ items: Line[]; changed: boolean }> {
  const out = items.slice();
  const stale = items
    .map((ci, i) => ({ ci, i }))
    .filter(({ ci }) => force || !ci.product.refreshedAt || Date.now() - ci.product.refreshedAt > REFRESH_TTL_MS);

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
