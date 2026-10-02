import { Platform } from '../services/storage';
import {
  CartCalculation,
  UnifiedProduct,
  getProductPlatformLimit,
  resolvePlatformProduct,
} from '../services/api';

type CartLine = { product: UnifiedProduct; quantity: number };

export interface LineFulfillment {
  line: CartLine;
  status: 'full' | 'capped' | 'oos' | 'unmatched';
  /** Units this platform can actually supply (0 when out of stock). */
  fulfilledQty: number;
  /** Stock/max-quantity limit when known (only meaningful for 'capped'). */
  limit?: number;
}

export interface PlatformFulfillment {
  lines: LineFulfillment[];
  oos: LineFulfillment[];
  /** Lines with no listing matched on this platform (skipped / not found) — not a stock problem. */
  unmatched: LineFulfillment[];
  capped: LineFulfillment[];
  fullLineCount: number;
  /** Lines the platform can supply at least 1 unit of. */
  availableLineCount: number;
  requestedUnits: number;
  fulfilledUnits: number;
  /** fulfilledUnits / requestedUnits, 0..1 */
  unitCoverage: number;
}

/**
 * Single source of truth for "what can this platform really deliver for this
 * basket" — shared by the verdict logic and the per-platform stock card.
 */
export function getPlatformFulfillment(
  calc: CartCalculation,
  cartItems: CartLine[],
  allCalcs: CartCalculation[],
): PlatformFulfillment {
  const lines: LineFulfillment[] = cartItems.map(line => {
    const id = line.product.id;
    const resolved = resolvePlatformProduct(line, calc.platform);
    const limit = calc.platformItemLimits?.[id] ?? getProductPlatformLimit(line.product, calc.platform, allCalcs);
    // No matched listing here (e.g. the user skipped this app for the item):
    // it can't be supplied, but that's not an out-of-stock condition.
    if (!resolved) return { line, status: 'unmatched', fulfilledQty: 0 };
    const oos =
      !!calc.outOfStockProductIds?.includes(id) ||
      resolved.product.inStock === false ||
      (limit !== undefined && limit <= 0);
    if (oos) return { line, status: 'oos', fulfilledQty: 0 };
    if (limit !== undefined && line.quantity > limit) {
      return { line, status: 'capped', fulfilledQty: limit, limit };
    }
    return { line, status: 'full', fulfilledQty: line.quantity };
  });

  const requestedUnits = cartItems.reduce((s, l) => s + l.quantity, 0);
  const fulfilledUnits = lines.reduce((s, l) => s + l.fulfilledQty, 0);
  const oos = lines.filter(l => l.status === 'oos');
  const capped = lines.filter(l => l.status === 'capped');
  const unmatched = lines.filter(l => l.status === 'unmatched');
  return {
    lines,
    oos,
    unmatched,
    capped,
    fullLineCount: lines.length - oos.length - capped.length - unmatched.length,
    availableLineCount: lines.length - oos.length - unmatched.length,
    requestedUnits,
    fulfilledUnits,
    unitCoverage: requestedUnits > 0 ? fulfilledUnits / requestedUnits : 0,
  };
}

export interface BasketVerdict {
  /** Best value overall (null when there is nothing meaningful to compare). */
  winnerKey: Platform | null;
  /** Platforms that fulfil the most units (only when some platform falls short). */
  mostCompleteKeys: Platform[];
  /** Cheapest bill among live platforms, even if it is incomplete. */
  lowestBillKey: Platform | null;
  /** True when the winner does not fulfil the whole basket. */
  winnerIsPartial: boolean;
  /** Per-platform fulfilment, keyed by platform, for UI reuse. */
  fulfillment: Partial<Record<Platform, PlatformFulfillment>>;
}

/** A platform below this share of the best coverage can't win on price alone. */
const MIN_RELATIVE_COVERAGE = 0.7;
/** Totals this close (₹) are treated as a tie — no badge on noise. */
const TIE_EPSILON = 1;

const EPS = 1e-9;

/**
 * Verdicts use REAL (live) bills only.
 *  - Best value: cheapest platform that delivers every unit; if none can,
 *    the lowest projected cost-per-unit among platforms that deliver at least
 *    70% of the best coverage (so a cheap-but-gutted basket can't win).
 *  - Most items: highest unit coverage, shown only when platforms differ.
 *  - Lowest bill: cheapest raw total, so users see why a pricier platform won.
 * Ties and single-platform baskets stay silent.
 */
export function computeBasketVerdict(
  calcs: CartCalculation[],
  cartItems: CartLine[],
): BasketVerdict {
  const fulfillment: BasketVerdict['fulfillment'] = {};
  for (const c of calcs) fulfillment[c.platform] = getPlatformFulfillment(c, cartItems, calcs);

  const real = calcs.filter(c => c.live && (fulfillment[c.platform]!.fulfilledUnits > 0));
  const empty: BasketVerdict = {
    winnerKey: null, mostCompleteKeys: [], lowestBillKey: null, winnerIsPartial: false, fulfillment,
  };
  if (real.length < 2) return empty;

  const cov = (c: CartCalculation) => fulfillment[c.platform]!.unitCoverage;
  const maxCov = Math.max(...real.map(cov));
  const minCov = Math.min(...real.map(cov));

  // Most items: only meaningful when platforms actually differ.
  const mostCompleteKeys = maxCov - minCov > EPS
    ? real.filter(c => maxCov - cov(c) <= EPS).map(c => c.platform)
    : [];

  // Lowest raw bill (ties → no badge).
  const byTotal = [...real].sort((a, b) => a.total - b.total);
  const lowestBillKey = byTotal[1].total - byTotal[0].total > TIE_EPSILON ? byTotal[0].platform : null;

  // Best value.
  const full = real.filter(c => cov(c) >= 1 - EPS);
  const pool = full.length > 0
    ? full
    : real.filter(c => cov(c) >= maxCov * MIN_RELATIVE_COVERAGE);
  // Rank by projected cost of the whole basket (== total when fully covered).
  const projected = (c: CartCalculation) => (cov(c) > 0 ? c.total / cov(c) : Infinity);
  const ranked = [...pool].sort((a, b) => projected(a) - projected(b));
  const tied = ranked.length > 1 && projected(ranked[1]) - projected(ranked[0]) <= TIE_EPSILON;
  const winner = tied || ranked.length === 0 ? null : ranked[0];

  return {
    winnerKey: winner ? winner.platform : null,
    mostCompleteKeys,
    lowestBillKey,
    winnerIsPartial: !!winner && cov(winner) < 1 - EPS,
    fulfillment,
  };
}
