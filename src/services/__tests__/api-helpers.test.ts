import {
  resolvePlatformProduct, getItemPlatformLimit, isKnownUnavailable, getProductPlatformLimit,
  getProductOverallMax, findStoreInfo, extractStockCount, instamartNormKey, pickInstamartCandidate,
  parseBlinkitBill, parseSwiggyBill, findSwiggyBillNode, parseBlinkitProducts, extractSwiggyStockAndLimit,
  invalidateAddressSessionCache,
} from '../api';
import { product, variant, calc } from './fixtures';

describe('getItemPlatformLimit', () => {
  it.each([
    [undefined, undefined],
    [{ availableStock: 5 }, 5],
    [{ maxQuantity: 3 }, 3],
    [{ availableStock: 5, maxQuantity: 3 }, 3],
    [{ availableStock: 0, maxQuantity: 3 }, 0],
    [{ availableStock: -1, maxQuantity: 0 }, undefined],
  ])('%j -> %s', (p, expected) => {
    expect(getItemPlatformLimit(p as any)).toBe(expected);
  });
});

describe('isKnownUnavailable', () => {
  it('is true for null, inStock=false and zero limits', () => {
    expect(isKnownUnavailable(null)).toBe(true);
    expect(isKnownUnavailable(product({ inStock: false }))).toBe(true);
    expect(isKnownUnavailable(product({ availableStock: 0 }))).toBe(true);
  });
  it('is false for normal or unknown-stock listings', () => {
    expect(isKnownUnavailable(product())).toBe(false);
    expect(isKnownUnavailable(product({ availableStock: 4 }))).toBe(false);
  });
});

describe('resolvePlatformProduct', () => {
  it('returns the product itself on its own platform, clamping qty to the limit', () => {
    const r = resolvePlatformProduct({ product: product({ availableStock: 2 }), quantity: 5 }, 'blinkit');
    expect(r?.quantity).toBe(2);
    expect(r?.product.id).toBe('blinkit-1');
  });
  it('returns null for a platform where the line does not exist', () => {
    expect(resolvePlatformProduct({ product: product(), quantity: 1 }, 'swiggy')).toBeNull();
  });
  it('maps to the matched variant and attributes it to the target platform', () => {
    const p = product({ platformPrices: { swiggy: variant({ id: 'swiggy-9', price: 31, quantity: '1 kg', maxQuantity: 2 }) } });
    const r = resolvePlatformProduct({ product: p, quantity: 4 }, 'swiggy')!;
    expect(r.product).toMatchObject({ platform: 'swiggy', id: 'swiggy-9', price: 31 });
    expect(r.quantity).toBe(2);
  });
  it('does not inherit the source platform\'s inStock when the variant does not say', () => {
    const p = product({ inStock: false, platformPrices: { swiggy: variant() } });
    const r = resolvePlatformProduct({ product: p, quantity: 1 }, 'swiggy')!;
    expect(r.product.inStock).toBeUndefined();
    expect(isKnownUnavailable(r.product)).toBe(false);
  });
});

describe('getProductPlatformLimit', () => {
  it('reads the limit from the own platform or the linked variant', () => {
    const p = product({ availableStock: 6, platformPrices: { swiggy: variant({ availableStock: 3 }) } });
    expect(getProductPlatformLimit(p, 'blinkit')).toBe(6);
    expect(getProductPlatformLimit(p, 'swiggy')).toBe(3);
    expect(getProductPlatformLimit(product(), 'swiggy')).toBeUndefined();
  });
  it('prefers live bill limits keyed by any known id', () => {
    const p = product({ availableStock: 6 });
    expect(getProductPlatformLimit(p, 'blinkit', [calc('blinkit', { platformItemLimits: { '1': 1 } })])).toBe(1);
    expect(getProductPlatformLimit(p, 'blinkit', [calc('swiggy', { platformItemLimits: { '1': 1 } })])).toBe(6);
  });
});

describe('getProductOverallMax', () => {
  it('defaults to 99 when nothing is known', () => {
    expect(getProductOverallMax(product()).maxAllowed).toBe(99);
  });
  it('uses the single platform limit', () => {
    expect(getProductOverallMax(product({ availableStock: 4 })).maxAllowed).toBe(4);
  });
  it('takes the larger limit across platforms and flags asymmetry', () => {
    const p = product({ availableStock: 2, platformPrices: { swiggy: variant({ availableStock: 5 }) } });
    expect(getProductOverallMax(p)).toMatchObject({ maxAllowed: 5, blinkitLimit: 2, swiggyLimit: 5, isAsymmetric: true });
  });
  it('never returns less than 1 when a limit is known', () => {
    expect(getProductOverallMax(product({ availableStock: 0 })).maxAllowed).toBe(1);
  });
});

describe('findStoreInfo', () => {
  it('finds store ids anywhere in a nested response, first value wins', () => {
    const info = findStoreInfo({ a: [{ storeId: 11 }], b: { c: { podId: 22, primaryStoreId: '33', secondaryStoreId: 44, layoutId: 'L' } } });
    expect(info).toEqual({ storeId: '11', primaryStoreId: '33', secondaryStoreId: '44', layoutId: 'L' });
  });
  it('returns empty info for junk and survives cycles', () => {
    const empty = { storeId: '', primaryStoreId: '', secondaryStoreId: '', layoutId: '' };
    expect(findStoreInfo(null)).toEqual(empty);
    const cyc: any = { x: 1 };
    cyc.self = cyc;
    expect(findStoreInfo(cyc)).toEqual(empty);
  });
});

describe('extractStockCount', () => {
  it.each([
    [7, 7],
    ['12', 12],
    ['Only 4 left', 4],
    ['5 in stock', 5],
    ['Max 3 per order', 3],
    ['Limit 2 per customer', 2],
    [{ allowedQuantity: 6 }, 6],
    [{ remaining_stock: 1 }, 1],
    [{ message: 'Only 2 left' }, 2],
    ['plenty', undefined],
    [-1, undefined],
    ['5000', undefined],
    [null, undefined],
  ])('%j -> %s', (input, expected) => {
    expect(extractStockCount(input)).toBe(expected);
  });
});

describe('extractSwiggyStockAndLimit', () => {
  it('returns {} with no input', () => {
    expect(extractSwiggyStockAndLimit(undefined)).toEqual({});
  });
  it('reads cartAllowedQuantity', () => {
    const r = extractSwiggyStockAndLimit({ cartAllowedQuantity: { allowedQuantity: 3, quantityLimitBreachedMessage: 'Only 3 in stock' } });
    expect(r.availableStock).toBe(3);
  });
});

describe('instamart candidate picking', () => {
  it('normalizes keys', () => {
    expect(instamartNormKey('Tata Salt-1 kg!')).toBe('tatasalt1kg');
  });
  const cands = [
    { productId: 'p1', name: 'Pav Bread', unit: '200 g', price: 30 },
    { productId: 'p2', name: 'Milk Bread', unit: '400 g', price: 45 },
  ];
  it('prefers an exact catalog id', () => {
    expect(pickInstamartCandidate(cands, 'Whatever', '1 kg', 1, 'p2')).toBe(cands[1]);
  });
  it('accepts only the same product, never a loose fallback', () => {
    expect(pickInstamartCandidate(cands, 'Pav Bread', '200 g', 30)).toBe(cands[0]);
    expect(pickInstamartCandidate(cands, 'Pav Bread', '400 g', 40)).toBeNull();
    expect(pickInstamartCandidate([], 'Pav Bread', '200 g')).toBeNull();
  });
});

describe('parseSwiggyBill / findSwiggyBillNode', () => {
  const bill = {
    toPay: '150.0', gst: '5.0', itemTotal: '100.0', convenienceFee: '3', smallCartCharges: 0,
    charges: [
      { type: 'deliveryCharge', value: '30.0', ctx: { chargesBreakup: [{ discValue: 30 }], inlineMessage: 'Add items worth ₹34 to avail your Swiggy One Free Delivery' } },
      { type: 'storePackagingCharges', value: '12.0006' },
    ],
  };
  it('maps charges, nets out delivery discounts, and states the free-delivery gap', () => {
    const f = parseSwiggyBill(bill);
    expect(f).toMatchObject({ subtotal: 100, deliveryFee: 0, handlingFee: 15, tax: 5, total: 150, surgeFee: 0, freeDeliveryGap: 34 });
  });
  it('captures named surge fees', () => {
    const f = parseSwiggyBill({ toPay: 100, itemTotal: 80, charges: [{ type: 'RAIN_FEE', value: 20, ctx: { displayName: 'Rain Fee' } }] });
    expect(f).toMatchObject({ surgeFee: 20, surgeLabel: 'Rain Fee' });
  });
  it('derives the subtotal from toPay when missing', () => {
    expect(parseSwiggyBill({ toPay: 100, gst: 10 }).subtotal).toBe(90);
  });
  it('returns an empty bill for junk', () => {
    expect(parseSwiggyBill(null)).toMatchObject({ subtotal: null, total: null, surgeFee: 0 });
  });
  it('locates the bill node at the documented path and by structural scan', () => {
    expect(findSwiggyBillNode({ data: { data: { bill } } })).toBe(bill);
    expect(findSwiggyBillNode({ deep: { nested: [{ x: bill }] } })).toBe(bill);
    expect(findSwiggyBillNode({ data: { bill: {} } })).toBeNull();
  });
});

describe('parseBlinkitBill', () => {
  it('maps bill_details, additional charges and free-delivery gap', () => {
    const json = {
      cart_data: {
        additional_charges: [{ charge_id: 3, amount: 4 }, { charge_id: 7, amount: 20 }, { charge_id: 5, amount: 10 }],
        bill_details: {
          total_cost: 180, delivery_charge: 25, payable_amount: 239, total_tax_on_charges: 0,
          flat_delivery_charge_attributes: { free_delivery_mov: 199 },
        },
      },
    };
    expect(parseBlinkitBill(json)).toMatchObject({
      subtotal: 180, deliveryFee: 25, handlingFee: 4, smallCartFee: 20, surgeFee: 10, total: 239, freeDeliveryGap: 19, surgeLabel: 'Late night charge',
    });
  });
  it('derives the subtotal from the total when absent', () => {
    expect(parseBlinkitBill({ bill_details: { payable_amount: 130, delivery_charge: 30 } }).subtotal).toBe(100);
  });
  it('parses numeric strings with currency symbols', () => {
    expect(parseBlinkitBill({ bill_details: { total_cost: '₹1,200', payable_amount: '₹1,200' } }).subtotal).toBe(1200);
  });
});

describe('parseBlinkitProducts', () => {
  it('extracts in-stock products from a nested response', () => {
    const json = { layout: [{ data: { name: { text: 'Amul Butter' }, price: '₹58', mrp: '₹60', unit: '100 g', id: 123 } }] };
    const [p] = parseBlinkitProducts(json);
    expect(p).toMatchObject({ name: 'Amul Butter', price: 58, mrp: 60, unit: '100 g', productId: '123' });
  });
  it('returns [] for junk', () => {
    expect(parseBlinkitProducts(null)).toEqual([]);
    expect(parseBlinkitProducts({ a: 1 })).toEqual([]);
  });
});

describe('invalidateAddressSessionCache', () => {
  it('is callable without state', () => {
    expect(() => invalidateAddressSessionCache()).not.toThrow();
  });
});

describe('edge cases: skipped apps and limits', () => {
  it('resolvePlatformProduct returns null for an app that was skipped (no variant, different source)', () => {
    expect(resolvePlatformProduct({ product: product(), quantity: 1 }, 'swiggy')).toBeNull();
  });

  it('getProductOverallMax with a skipped app only reflects the source app', () => {
    const p = product({ availableStock: 4 });
    expect(getProductOverallMax(p)).toMatchObject({ maxAllowed: 4, blinkitLimit: 4, swiggyLimit: undefined, isAsymmetric: false });
  });

  it('getProductOverallMax defaults to 99 with no stock info and is never below 1 when a limit is known', () => {
    expect(getProductOverallMax(product()).maxAllowed).toBe(99);
    const zero = product({ availableStock: 0, platformPrices: { swiggy: variant({ availableStock: 0 }) } });
    expect(getProductOverallMax(zero).maxAllowed).toBe(1);
  });

  it('getProductOverallMax is asymmetric only when both limits are known and differ', () => {
    const same = product({ availableStock: 3, platformPrices: { swiggy: variant({ availableStock: 3 }) } });
    expect(getProductOverallMax(same).isAsymmetric).toBe(false);
    const oneUnknown = product({ availableStock: 3, platformPrices: { swiggy: variant() } });
    expect(getProductOverallMax(oneUnknown).isAsymmetric).toBe(false);
  });

  it('resolvePlatformProduct clamps quantity to a variant stock limit but never to zero', () => {
    const p = product({ platformPrices: { swiggy: variant({ availableStock: 2 }) } });
    expect(resolvePlatformProduct({ product: p, quantity: 5 }, 'swiggy')!.quantity).toBe(2);
    const z = product({ platformPrices: { swiggy: variant({ availableStock: 0 }) } });
    expect(resolvePlatformProduct({ product: z, quantity: 5 }, 'swiggy')!.quantity).toBe(5);
  });
});
