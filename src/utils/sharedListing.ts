import { UnifiedProduct, resolvePlatformProduct } from '../services/api';
import { liveKey } from './productKey';

// Two basket lines can auto-match to the SAME listing on the other app (e.g.
// Blinkit "Toned Milk" and "Full Cream Milk" both → Instamart "Pasteurized
// Milk"). These helpers treat such a listing as one thing shared by N lines.

type Line = { product: UnifiedProduct; quantity: number };

const sameListing = (a: { id?: string; title: string; quantity: string }, b: UnifiedProduct): boolean =>
  (!!a.id && a.id === b.id) || liveKey({ name: a.title, unit: a.quantity }) === liveKey({ name: b.title, unit: b.quantity });

/** Indexes of every basket line whose own listing or any stored variant is `product`. */
export function lineIdxsForListing(items: Line[], product: UnifiedProduct): number[] {
  const idxs: number[] = [];
  items.forEach((ci, i) => {
    if (sameListing(ci.product, product) || Object.values(ci.product.platformPrices || {}).some(v => sameListing(v, product))) {
      idxs.push(i);
    }
  });
  return idxs;
}

/** Quantity of `product`'s listing in the basket, summed over every line sharing it. */
export function listingQty(items: Line[], product: UnifiedProduct): number {
  return lineIdxsForListing(items, product).reduce((sum, i) => {
    const resolved = resolvePlatformProduct(items[i], product.platform);
    return sum + (resolved ? resolved.quantity : items[i].quantity);
  }, 0);
}

/**
 * Collapse export rows that point at the same listing into one row with the
 * combined quantity, clamped to that listing's stock (`limits[i]` is the limit
 * for `items[i]`). Order of first appearance is kept.
 */
export function mergeExportItems<T extends { quantity: number; name: string }>(
  items: T[],
  keyOf: (item: T) => string,
  limits: (number | undefined)[],
): { items: T[]; clamped: { name: string; requestedQty: number; exportedQty: number }[] } {
  const order: string[] = [];
  const byKey = new Map<string, { item: T; limit?: number; dupes: number }>();
  items.forEach((item, i) => {
    const k = keyOf(item);
    const hit = byKey.get(k);
    if (hit) {
      hit.item = { ...hit.item, quantity: hit.item.quantity + item.quantity };
      hit.dupes++;
    } else {
      order.push(k);
      byKey.set(k, { item: { ...item }, limit: limits[i], dupes: 0 });
    }
  });
  const clamped: { name: string; requestedQty: number; exportedQty: number }[] = [];
  const merged = order.map(k => {
    const { item, limit, dupes } = byKey.get(k)!;
    if (dupes > 0 && typeof limit === 'number' && limit > 0 && item.quantity > limit) {
      clamped.push({ name: item.name, requestedQty: item.quantity, exportedQty: limit });
      return { ...item, quantity: limit };
    }
    return item;
  });
  return { items: merged, clamped };
}
