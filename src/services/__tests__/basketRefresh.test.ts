import { refreshBasketLines, applyLiveLimits } from '../basketRefresh';
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
