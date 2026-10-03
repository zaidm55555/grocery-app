import { lineIdxsForListing, listingQty, mergeExportItems } from '../sharedListing';
import { product, variant } from '../../services/__tests__/fixtures';

const swMilk = variant({ id: 'swiggy-5', title: 'Pasteurized Milk', quantity: '500 ml' });
const line = (id: string, title: string, quantity: number, shared = true) => ({
  product: product({ id, title, quantity: '500 ml', platformPrices: shared ? { swiggy: swMilk } : undefined }),
  quantity,
});
const swListing = product({ id: 'swiggy-5', title: 'Pasteurized Milk', quantity: '500 ml', platform: 'swiggy' });

describe('lineIdxsForListing', () => {
  it('returns every basket line that points at the same listing', () => {
    const items = [line('blinkit-1', 'Toned Milk', 2), line('blinkit-2', 'Full Cream Milk', 1), line('blinkit-3', 'Curd', 1, false)];
    expect(lineIdxsForListing(items, swListing)).toEqual([0, 1]);
  });

  it('matches a line by its own listing too', () => {
    const items = [line('blinkit-1', 'Toned Milk', 2)];
    expect(lineIdxsForListing(items, items[0].product)).toEqual([0]);
  });

  it('matches by catalog id even when the title differs', () => {
    const items = [line('blinkit-1', 'Toned Milk', 2)];
    expect(lineIdxsForListing(items, { ...swListing, title: 'Totally Renamed' })).toEqual([0]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(lineIdxsForListing([line('blinkit-3', 'Curd', 1, false)], swListing)).toEqual([]);
  });
});

describe('listingQty', () => {
  it('sums the quantity of every line sharing the listing', () => {
    const items = [line('blinkit-1', 'Toned Milk', 2), line('blinkit-2', 'Full Cream Milk', 3)];
    expect(listingQty(items, swListing)).toBe(5);
  });

  it('is 0 when the listing is not in the basket', () => {
    expect(listingQty([line('blinkit-3', 'Curd', 1, false)], swListing)).toBe(0);
  });

  it('counts each line at the quantity the platform can actually supply', () => {
    const capped = { ...swMilk, availableStock: 2 };
    const items = [
      { product: product({ id: 'blinkit-1', title: 'Toned Milk', platformPrices: { swiggy: capped } }), quantity: 5 },
    ];
    expect(listingQty(items, swListing)).toBe(2);
  });
});

describe('mergeExportItems', () => {
  const it1 = (productId: string, quantity: number, name = 'Milk') => ({ productId, quantity, name });

  it('merges duplicate listings into one line with the summed quantity', () => {
    const r = mergeExportItems([it1('p1', 2), it1('p2', 1, 'Curd'), it1('p1', 3)], i => i.productId, [undefined, undefined, undefined]);
    expect(r.items).toEqual([it1('p1', 5), it1('p2', 1, 'Curd')]);
    expect(r.clamped).toEqual([]);
  });

  it('clamps the merged quantity to the shared stock limit and reports it', () => {
    const r = mergeExportItems([it1('p1', 3), it1('p1', 3)], i => i.productId, [4, 4]);
    expect(r.items).toEqual([it1('p1', 4)]);
    expect(r.clamped).toEqual([{ name: 'Milk', requestedQty: 6, exportedQty: 4 }]);
  });

  it('leaves non-duplicate items untouched and in order', () => {
    const items = [it1('a', 1), it1('b', 2)];
    expect(mergeExportItems(items, i => i.productId, [undefined, undefined]).items).toEqual(items);
  });
});
