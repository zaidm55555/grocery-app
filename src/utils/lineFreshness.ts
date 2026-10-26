// When a basket line must be re-checked against the live catalogs.
//
// A line is stamped (`refreshedAt`) when it is added or re-checked. A listing
// fetched through the store the cart bills from is trusted for an hour; anything
// else (the Blinkit direct fallback, which answers from another dark store, or
// an old saved line) for 10 minutes. The live bill still corrects price and
// stock, so the window only decides when the catalog crawl is worth repeating.
import type { UnifiedProduct, PlatformVariant } from '../services/api';
import type { Platform } from '../services/storage';

export const REFRESH_TTL_MS = 10 * 60 * 1000;
export const VERIFIED_TRUST_MS = 60 * 60 * 1000;

// Blinkit flags every search result: true = answered by the bridged page (the
// cart's store), false = the direct fallback. Instamart search has no fallback
// store and leaves the flag unset, so there only an explicit false counts.
export function isListingVerified(platform: Platform, listing: Pick<PlatformVariant, 'storeVerified'>): boolean {
  return platform === 'blinkit' ? listing.storeVerified === true : listing.storeVerified !== false;
}

/** The line's own listing and every linked twin came from the right store. */
export function isLineVerified(product: UnifiedProduct): boolean {
  return isListingVerified(product.platform, product) &&
    (Object.entries(product.platformPrices || {}) as [Platform, PlatformVariant | undefined][])
      .every(([pl, v]) => !v || isListingVerified(pl, v));
}

export function needsRefresh(product: UnifiedProduct, now = Date.now()): boolean {
  if (!product.refreshedAt) return true;
  return now - product.refreshedAt > (isLineVerified(product) ? VERIFIED_TRUST_MS : REFRESH_TTL_MS);
}

/**
 * For a line just built from search results: stamp it as checked now when every
 * listing came from the right store, so opening the basket doesn't search for
 * it again. Otherwise any earlier stamp is dropped so the line gets re-checked.
 */
export function stampIfVerified<T extends UnifiedProduct>(product: T, now = Date.now()): T {
  if (isLineVerified(product)) return { ...product, refreshedAt: now };
  return product.refreshedAt === undefined ? product : { ...product, refreshedAt: undefined };
}
