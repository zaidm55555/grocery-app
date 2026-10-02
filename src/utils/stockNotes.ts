import type { Platform } from '../services/storage';

/** Stock counts at or below this are surfaced in the basket (badges + footer). */
export const STOCK_BADGE_MAX = 15;

export interface StockVariant {
  platform: Platform;
  isOos: boolean;
  isCapped: boolean;
  platformLimit?: number;
}

export interface StockFooterEntry {
  platform: Platform;
  /** Known stock, or undefined when the app reported none ("in stock"). */
  limit?: number;
  /** Stock is below the requested quantity, so this app bills fewer units. */
  capped: boolean;
}

/**
 * Footer under a basket line. One rule: when 2+ apps price the line in stock and
 * any of them has a known low stock, list every in-stock app. Otherwise null.
 */
export function getStockFooter(variants: StockVariant[]): StockFooterEntry[] | null {
  const live = variants.filter(v => !v.isOos);
  const anyLow = live.some(v => v.platformLimit !== undefined && v.platformLimit <= STOCK_BADGE_MAX);
  if (live.length < 2 || !anyLow) return null;
  return live.map(v => ({ platform: v.platform, limit: v.platformLimit, capped: v.isCapped }));
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
