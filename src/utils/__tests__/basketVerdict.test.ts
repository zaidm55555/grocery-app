import { computeBasketVerdict, getPlatformFulfillment } from '../basketVerdict';
import { product, variant, calc } from '../../services/__tests__/fixtures';

// A line available on both platforms.
const both = (id: string, qty = 1, over = {}) => ({
  product: product({ id: `blinkit-${id}`, platformPrices: { swiggy: variant({ id: `swiggy-${id}` }) }, ...over }),
  quantity: qty,
});

describe('getPlatformFulfillment', () => {
  it('marks lines with no match on a platform as unmatched, not out of stock', () => {
    const line = { product: product(), quantity: 2 }; // blinkit only
    const f = getPlatformFulfillment(calc('swiggy'), [line], []);
    expect(f.lines[0].status).toBe('unmatched');
    expect(f.oos).toHaveLength(0);
    expect(f.unmatched).toHaveLength(1);
    expect(f.fulfilledUnits).toBe(0);
    expect(f.availableLineCount).toBe(0);
    expect(f.unitCoverage).toBe(0);
  });

  it('marks lines capped when the stock limit is below the requested qty', () => {
    const line = { product: product({ availableStock: 2 }), quantity: 5 };
    const f = getPlatformFulfillment(calc('blinkit'), [line], []);
    expect(f.lines[0]).toMatchObject({ status: 'capped', fulfilledQty: 2, limit: 2 });
    expect(f.capped).toHaveLength(1);
    expect(f.unitCoverage).toBeCloseTo(0.4);
  });

  it('treats live-bill oos ids and zero limits as out of stock', () => {
    const line = { product: product(), quantity: 1 };
    expect(getPlatformFulfillment(calc('blinkit', { outOfStockProductIds: ['blinkit-1'] }), [line], []).oos).toHaveLength(1);
    expect(getPlatformFulfillment(calc('blinkit', { platformItemLimits: { 'blinkit-1': 0 } }), [line], []).oos).toHaveLength(1);
    expect(getPlatformFulfillment(calc('blinkit'), [{ product: product({ inStock: false }), quantity: 1 }], []).oos).toHaveLength(1);
  });

  it('is fully fulfilled for a plain in-stock line', () => {
    const f = getPlatformFulfillment(calc('blinkit'), [{ product: product(), quantity: 3 }], []);
    expect(f).toMatchObject({ fullLineCount: 1, requestedUnits: 3, fulfilledUnits: 3, unitCoverage: 1 });
  });

  it('handles an empty basket', () => {
    expect(getPlatformFulfillment(calc('blinkit'), [], []).unitCoverage).toBe(0);
  });
});

describe('computeBasketVerdict', () => {
  const items = [both('a', 2), both('b', 1)];

  it('picks the cheaper platform when both fully cover the basket', () => {
    const v = computeBasketVerdict([calc('blinkit', { total: 200 }), calc('swiggy', { total: 150 })], items);
    expect(v.winnerKey).toBe('swiggy');
    expect(v.lowestBillKey).toBe('swiggy');
    expect(v.winnerIsPartial).toBe(false);
    expect(v.mostCompleteKeys).toEqual([]);
  });

  it('stays silent on ties within ₹1', () => {
    const v = computeBasketVerdict([calc('blinkit', { total: 100 }), calc('swiggy', { total: 100.5 })], items);
    expect(v.winnerKey).toBeNull();
    expect(v.lowestBillKey).toBeNull();
  });

  it('ignores non-live calculations', () => {
    const v = computeBasketVerdict([calc('blinkit', { total: 200 }), calc('swiggy', { total: 100, live: false })], items);
    expect(v.winnerKey).toBeNull();
  });

  it('needs at least two live platforms', () => {
    const v = computeBasketVerdict([calc('blinkit', { total: 200 })], items);
    expect(v).toMatchObject({ winnerKey: null, mostCompleteKeys: [], lowestBillKey: null, winnerIsPartial: false });
  });

  it('does not let a cheap but gutted basket win', () => {
    // swiggy only stocks 1 of 3 units (cheap), blinkit covers everything.
    const lines = [both('a', 2, { platformPrices: { swiggy: variant({ availableStock: 0, inStock: false }) } }), both('b', 1)];
    const v = computeBasketVerdict([calc('blinkit', { total: 300 }), calc('swiggy', { total: 50 })], lines);
    expect(v.winnerKey).toBe('blinkit');
    expect(v.mostCompleteKeys).toEqual(['blinkit']);
    expect(v.lowestBillKey).toBe('swiggy');
    expect(v.winnerIsPartial).toBe(false);
  });

  it('flags a partial winner when no platform covers everything', () => {
    const lines = [
      both('a', 1, { platformPrices: { swiggy: variant({ inStock: false }) } }),
      both('b', 1, { availableStock: 0, inStock: false, platformPrices: { swiggy: variant({ inStock: true }) } }),
      both('c', 1),
      both('d', 1),
    ];
    // blinkit: 3/4 (b oos), swiggy: 3/4 (a oos) -> both partial, cheaper wins
    const v = computeBasketVerdict([calc('blinkit', { total: 90 }), calc('swiggy', { total: 60 })], lines);
    expect(v.winnerKey).toBe('swiggy');
    expect(v.winnerIsPartial).toBe(true);
  });

  it('exposes per-platform fulfillment for the UI', () => {
    const v = computeBasketVerdict([calc('blinkit', { total: 1 }), calc('swiggy', { total: 2 })], items);
    expect(v.fulfillment.blinkit?.requestedUnits).toBe(3);
    expect(v.fulfillment.swiggy?.fulfilledUnits).toBe(3);
  });
});
