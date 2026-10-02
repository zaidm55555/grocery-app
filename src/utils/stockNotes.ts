import type { Platform } from '../services/storage';

/** Stock counts at or below this are surfaced in the basket (badges + footer). */
export const STOCK_BADGE_MAX = 15;

/** Green "N in stock" badge shows only when fewer than this many units remain beyond the basket quantity. */
export const STOCK_BADGE_REMAINING_MAX = 5;

export function shouldShowStockBadge(limit: number | undefined, quantity: number): boolean {
  if (limit === undefined || limit <= 0) return false;
  return limit - quantity < STOCK_BADGE_REMAINING_MAX;
}

export interface StockVariant {
  platform: Platform;
  isOos: boolean;
  isCapped: boolean;
  platformLimit?: number;
}

/**
 * Search shows a "fetched directly" note when Blinkit is linked but the bridge
 * page isn't connected (direct requests can return other stores' stock).
 */
export function shouldShowBlinkitDirectNote(opts: {
  blinkitLinked: boolean;
  bridgeConnected: boolean;
  storeFilter: 'all' | Platform;
}): boolean {
  return opts.blinkitLinked && !opts.bridgeConnected && opts.storeFilter !== 'swiggy';
}
