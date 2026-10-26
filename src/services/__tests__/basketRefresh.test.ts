import { refreshBasketLines, applyLiveLimits, mergeRefreshedLines } from '../basketRefresh';
import { api } from '../api';
import { product, variant, calc } from './fixtures';

let search: jest.SpyInstance;

beforeEach(() => {
  // jest.setup restores spies after each test, so re-create it every time.
  search = jest.spyOn(api, 'searchSingle');
});

const live = (over = {}) => product({ id: 'blinkit-1', productId: 'p1', price: 33, ...over });

describe('refreshBasketLines', () => {
  it('refreshes a stale line by catalog id and stamps refreshedAt', async () => {
    search.mockResolvedValue([live()]);
    const { items, changed } = await refreshBasketLines([{ product: product({ productId: 'p1', price: 28 }), quantity: 2 }]);
    expect(changed).toBe(true);
    expect(items[0].product.price).toBe(33);
    expect(items[0].quantity).toBe(2);
    expect(items[0].product.refreshedAt).toBeGreaterThan(0);
  });

  it('does not jump to another pack size that shares the productId', async () => {
    const single = product({ id: 'swiggy-100', platform: 'swiggy', productId: 'shared', originalId: '100', spinId: 'spin-100', title: 'Milky Mist Salted Butter', quantity: '100 g', price: 82 });
    const triple = { ...single, id: 'swiggy-300', originalId: '300', spinId: 'spin-300', quantity: '3 x 100 g', price: 246 };
    search.mockResolvedValue([triple, { ...single, price: 85 }]);
    const { items } = await refreshBasketLines([{ product: single, quantity: 1 }]);
    expect(items[0].product.quantity).toBe('100 g');
    expect(items[0].product.price).toBe(85);
  });

  it('skips fresh lines unless forced', async () => {
    const fresh = { product: product({ refreshedAt: Date.now() }), quantity: 1 };
    expect((await refreshBasketLines([fresh])).changed).toBe(false);
    expect(search).not.toHaveBeenCalled();
    search.mockResolvedValue([]);
    expect((await refreshBasketLines([fresh], true)).changed).toBe(true);
    expect(search).toHaveBeenCalled();
  });

  it('flags a line unavailable instead of relinking it to a different product', async () => {
    search.mockResolvedValue([live({ id: 'blinkit-2', productId: 'p2', title: 'Aashirvaad Atta', quantity: '5 kg' })]);
    const { items } = await refreshBasketLines([{ product: product({ productId: 'p1' }), quantity: 1 }]);
    expect(items[0].product).toMatchObject({ title: 'Tata Salt', inStock: false, availableStock: 0 });
  });

  it('keeps the stored line when search returns nothing or throws', async () => {
    search.mockResolvedValue([]);
    const stored = product({ price: 28 });
    expect((await refreshBasketLines([{ product: stored, quantity: 1 }])).items[0].product).toMatchObject({ price: 28 });
    search.mockRejectedValue(new Error('net'));
    const r = await refreshBasketLines([{ product: stored, quantity: 1 }]);
    expect(r.items[0].product).toBe(stored);
  });

  it('drops a bad cross-platform link from an older matcher and relinks a proper match', async () => {
    const bad = variant({ id: 'swiggy-9', title: 'Aashirvaad Atta', quantity: '5 kg', productId: 's9' });
    search.mockImplementation(async (platform, q) =>
      platform === 'blinkit'
        ? [live()]
        : [product({ id: 'swiggy-5', platform: 'swiggy', productId: 's5', title: 'Tata Salt', quantity: '1 kg', price: 30 })]);
    const { items } = await refreshBasketLines([{ product: product({ productId: 'p1', platformPrices: { swiggy: bad } }), quantity: 1 }]);
    expect(items[0].product.platformPrices?.swiggy?.productId).toBe('s5');
  });

  it('removes a bad link when the other platform has no match at all', async () => {
    const bad = variant({ title: 'Aashirvaad Atta', quantity: '5 kg' });
    search.mockImplementation(async (platform) =>
      platform === 'blinkit' ? [live()] : [product({ id: 'swiggy-7', platform: 'swiggy', title: 'Maggi', quantity: '70 g' })]);
    const { items } = await refreshBasketLines([{ product: product({ productId: 'p1', platformPrices: { swiggy: bad } }), quantity: 1 }]);
    expect(items[0].product.platformPrices).toBeUndefined();
  });

  it('keeps a manually picked link even though it scores as a weak match', async () => {
    const picked = variant({ id: 'swiggy-9', title: 'Aashirvaad Atta', quantity: '5 kg', productId: 's9', originalId: '9', manual: true });
    search.mockImplementation(async (platform) =>
      platform === 'blinkit' ? [live()] : [product({ id: 'swiggy-9', platform: 'swiggy', productId: 's9', originalId: '9', title: 'Aashirvaad Atta', quantity: '5 kg', price: 280 })]);
    const { items } = await refreshBasketLines([{ product: product({ productId: 'p1', platformPrices: { swiggy: picked } }), quantity: 1 }]);
    expect(items[0].product.platformPrices?.swiggy).toMatchObject({ productId: 's9', price: 280, manual: true });
  });

  it('keeps a manual link when its own search returns nothing relevant', async () => {
    const picked = variant({ id: 'swiggy-9', title: 'Aashirvaad Atta', quantity: '5 kg', productId: 's9', manual: true });
    search.mockImplementation(async (platform) => (platform === 'blinkit' ? [live()] : []));
    const { items } = await refreshBasketLines([{ product: product({ productId: 'p1', platformPrices: { swiggy: picked } }), quantity: 1 }]);
    expect(items[0].product.platformPrices?.swiggy?.productId).toBe('s9');
  });

  it('retries the search with the pack size stripped from the title', async () => {
    search.mockImplementation(async (_p, q) => (q === 'Tata Salt 1 kg' ? [] : [live()]));
    await refreshBasketLines([{ product: product({ title: 'Tata Salt 1 kg', productId: 'p1' }), quantity: 1 }]);
    expect(search.mock.calls.map(c => c[1])).toEqual(['Tata Salt 1 kg', 'Tata Salt']);
  });
});

describe('refreshBasketLines: trust window', () => {
  const MIN = 60 * 1000;
  const ago = (m: number) => Date.now() - m * MIN;
  const twin = { swiggy: variant({ id: 'swiggy-1' }) };

  it('does not search a bridge-verified line stamped within the hour', async () => {
    const verified = { product: product({ storeVerified: true, refreshedAt: ago(45), platformPrices: twin }), quantity: 1 };
    const r = await refreshBasketLines([verified]);
    expect(r.changed).toBe(false);
    expect(r.items[0]).toBe(verified);
    expect(search).not.toHaveBeenCalled();
  });

  it('re-checks a verified line once the trust window has passed', async () => {
    search.mockResolvedValue([live({ storeVerified: true })]);
    const old = { product: product({ productId: 'p1', storeVerified: true, refreshedAt: ago(61) }), quantity: 1 };
    const r = await refreshBasketLines([old]);
    expect(r.changed).toBe(true);
    expect(search).toHaveBeenCalledWith('blinkit', 'Tata Salt');
  });

  it('keeps the 10-minute TTL for a line from the Blinkit fallback store', async () => {
    search.mockResolvedValue([]);
    const recent = { product: product({ storeVerified: false, refreshedAt: ago(5) }), quantity: 1 };
    expect((await refreshBasketLines([recent])).changed).toBe(false);
    expect(search).not.toHaveBeenCalled();
    const older = { product: product({ storeVerified: false, refreshedAt: ago(15) }), quantity: 1 };
    expect((await refreshBasketLines([older])).changed).toBe(true);
    expect(search).toHaveBeenCalled();
  });

  it('re-checks a verified line whose twin came from the fallback store on the short TTL', async () => {
    search.mockResolvedValue([]);
    const mixed = { product: { ...product({ id: 'swiggy-1', platform: 'swiggy', refreshedAt: ago(15) }), platformPrices: { blinkit: variant({ id: 'blinkit-1', storeVerified: false }) } }, quantity: 1 };
    expect((await refreshBasketLines([mixed])).changed).toBe(true);
  });

  it('only searches the lines that need it in a mixed basket', async () => {
    search.mockResolvedValue([]);
    const fresh = { product: product({ id: 'blinkit-1', title: 'Fresh', storeVerified: true, refreshedAt: ago(1) }), quantity: 1 };
    const stale = { product: product({ id: 'blinkit-2', title: 'Unstamped', storeVerified: true }), quantity: 1 };
    const r = await refreshBasketLines([fresh, stale]);
    expect(search.mock.calls.map(c => c[1])).toEqual(['Unstamped']);
    expect(r.items[0]).toBe(fresh);
    expect(r.items[1].product.refreshedAt).toBeGreaterThan(0);
  });
});

describe('mergeRefreshedLines', () => {
  const line = (id: string, over = {}, quantity = 1) => ({ product: product({ id, title: id, ...over }), quantity });

  it('takes a corrected line but keeps the quantity the user has now', () => {
    const before = [line('a', { price: 10 })];
    const after = [{ ...before[0], product: { ...before[0].product, price: 12, refreshedAt: 5 } }];
    const current = [line('a', { price: 10 }, 4)];
    const r = mergeRefreshedLines(current, before, after);
    expect(r).toMatchObject({ changed: true, repriced: true });
    expect(r.items[0]).toMatchObject({ quantity: 4, product: { price: 12, refreshedAt: 5 } });
  });

  it('only records the check when nothing moved, keeping what the bill wrote since', () => {
    const before = [line('a', { price: 10 })];
    const after = [{ ...before[0], product: { ...before[0].product, refreshedAt: 5 } }];
    const current = [line('a', { price: 10, availableStock: 3 })]; // live bill limit written meanwhile
    const r = mergeRefreshedLines(current, before, after);
    expect(r).toMatchObject({ changed: true, repriced: false });
    expect(r.items[0].product).toMatchObject({ price: 10, availableStock: 3, refreshedAt: 5 });
  });

  it('ignores key order and unset fields when deciding whether a line moved', () => {
    const before = [{ product: { ...product({ id: 'a' }), platformPrices: { swiggy: { ...variant(), manual: true } } }, quantity: 1 }];
    const v = before[0].product.platformPrices.swiggy;
    const reordered = { manual: true, imageUrl: v.imageUrl, price: v.price, quantity: v.quantity, brand: v.brand, title: v.title, id: v.id, originalPrice: undefined };
    const after = [{ ...before[0], product: { ...before[0].product, platformPrices: { swiggy: reordered }, refreshedAt: 5 } }];
    expect(mergeRefreshedLines(before, before, after).repriced).toBe(false);
  });

  it('leaves lines the refresh skipped, removed lines, and new lines alone', () => {
    const a = line('a');
    const b = line('b');
    const after = [a, { ...b, product: { ...b.product, price: 99, refreshedAt: 5 } }];
    const added = line('c');
    const r = mergeRefreshedLines([a, added], [a, b], after); // b was removed meanwhile
    expect(r.items).toEqual([a, added]);
    expect(r.items[0]).toBe(a);
    expect(r).toMatchObject({ changed: false, repriced: false });
  });
});

describe('applyLiveLimits', () => {
  it('writes bill-discovered limits onto the matching line', () => {
    const line = { product: product(), quantity: 1 };
    const { items, changed } = applyLiveLimits([line], [calc('blinkit', { platformItemLimits: { 'blinkit-1': 3 } })]);
    expect(changed).toBe(true);
    expect(items[0].product.availableStock).toBe(3);
  });
  it('marks a zero limit as out of stock, including on linked variants', () => {
    const line = { product: product({ platformPrices: { swiggy: variant({ id: 'swiggy-1' }) } }), quantity: 1 };
    const { items } = applyLiveLimits([line], [calc('swiggy', { platformItemLimits: { 'swiggy-1': 0 } })]);
    expect(items[0].product.platformPrices?.swiggy).toMatchObject({ availableStock: 0, inStock: false });
  });
  it('is a no-op when nothing differs', () => {
    const line = { product: product({ availableStock: 3 }), quantity: 1 };
    const r = applyLiveLimits([line], [calc('blinkit', { platformItemLimits: { 'blinkit-1': 3 } })]);
    expect(r.changed).toBe(false);
    expect(r.items[0]).toBe(line);
  });
});
