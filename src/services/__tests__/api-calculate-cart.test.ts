import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../api';
import { storage } from '../storage';
import * as pricing from '../blinkitPricing';
import { product, variant } from './fixtures';

jest.mock('../blinkitPricing', () => ({ priceBlinkitCart: jest.fn() }));
jest.mock('../swiggyBridge', () => ({ requestViaSwiggyBridge: jest.fn(), requestEvalViaSwiggyBridge: jest.fn() }));
const priceBlinkit = pricing.priceBlinkitCart as jest.Mock;

const res = (body: any, ok = true, status = ok ? 200 : 400) => ({
  ok, status,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const STORE = { storeId: 'S1', primaryStoreId: 'P1', secondaryStoreId: '', layoutId: 'L1' };
const DELIVERY = { id: 'addr1', name: 'Home', location: { latitude: 22.31, longitude: 73.11 } };

// A line matched on swiggy with stored ids (fast path).
const swiggyLine = (over: any = {}, quantity = 2) => ({
  product: product({ id: 'swiggy-9', platform: 'swiggy', title: 'Tata Salt', price: 50, originalId: 'item9', productId: 'prod9', spinId: 'sp9', ...over }),
  quantity,
});
// A blinkit-origin line that also has a swiggy variant.
const bothLine = (quantity = 2, bOver: any = {}, sOver: any = {}) => ({
  product: product({ id: 'blinkit-1', price: 40, originalPrice: 45, originalId: '1', ...bOver, platformPrices: { swiggy: variant({ id: 'swiggy-1', price: 50, originalId: 'i1', productId: 'p1', spinId: 's1', ...sOver }) } }),
  quantity,
});

const bill = (over: any = {}) => ({
  toPay: '160', gst: '5', itemTotal: '100', convenienceFee: '3',
  charges: [{ type: 'deliveryCharge', value: '30', ctx: {} }, { type: 'storePackagingCharges', value: '12' }],
  ...over,
});
const cartResp = (over: any = {}, billOver: any = {}) => ({
  data: { data: { cartId: 'C1', addressId: 'addr1', bill: bill(billOver), items: [], ...over } },
});

let calls: { url: string; method: string; body?: any }[];
function swiggyRoute(handler: (url: string, method: string, body: any) => any) {
  calls = [];
  jest.spyOn(api, 'swiggyApiFetch').mockImplementation(async (url: string, method = 'GET', body?: string) => {
    const parsed = body ? JSON.parse(body) : undefined;
    calls.push({ url, method, body: parsed });
    return handler(url, method, parsed);
  });
}
const posts = () => calls.filter(c => c.method === 'POST');

beforeEach(async () => {
  await AsyncStorage.clear();
  priceBlinkit.mockReset();
  await storage.saveLocation({ latitude: 22.3, longitude: 73.1 });
  jest.spyOn(api, 'resolveSwiggyDeliveryAddress').mockResolvedValue(DELIVERY);
  await AsyncStorage.setItem('@swiggy_store_cache', JSON.stringify({ locKey: '22.310,73.110', at: Date.now(), storeInfo: STORE }));
});

describe('calculateCart: shared behaviour', () => {
  it('returns a baseline (subtotal only, not live) when no app is linked', async () => {
    const r = await api.calculateCart([bothLine(2)]);
    expect(r.map(c => c.platform)).toEqual(['blinkit', 'swiggy']);
    const b = r.find(c => c.platform === 'blinkit')!;
    const s = r.find(c => c.platform === 'swiggy')!;
    expect(b).toMatchObject({ subtotal: 80, total: 80, live: false, deliveryFee: 0, handlingFee: 0, tax: 0 });
    expect(s).toMatchObject({ subtotal: 100, total: 100, live: false });
    expect(b.savings).toBe(10); // (45-40)*2
  });

  it('only prices the target platform and fires the callback once per platform', async () => {
    const cb = jest.fn();
    const r = await api.calculateCart([bothLine()], cb, 'swiggy');
    expect(r).toHaveLength(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].platform).toBe('swiggy');
    const all = jest.fn();
    await api.calculateCart([bothLine()], all);
    expect(all).toHaveBeenCalledTimes(2);
  });

  it('only prices lines that exist on a platform; a skipped line is classified out of that platform and costs nothing', async () => {
    const skipped = { product: product({ id: 'blinkit-2', price: 30 }), quantity: 1 }; // no swiggy variant
    const r = await api.calculateCart([bothLine(1), skipped]);
    const s = r.find(c => c.platform === 'swiggy')!;
    expect(s.subtotal).toBe(50);
    expect(s.items).toHaveLength(1);
    expect(s.outOfStockProductIds).toContain('blinkit-2');
    expect(s.inStockProductIds).toEqual(['blinkit-1']);
    expect(r.find(c => c.platform === 'blinkit')!.subtotal).toBe(70);
  });

  it('caps the baseline subtotal at the known stock limit', async () => {
    const r = await api.calculateCart([bothLine(5, { availableStock: 2 })], undefined, 'blinkit');
    expect(r[0].subtotal).toBe(80); // 2 units × 40, not 5
  });

  it('an empty basket produces empty, zero calculations', async () => {
    const r = await api.calculateCart([]);
    expect(r.every(c => c.subtotal === 0 && c.total === 0 && c.items.length === 0)).toBe(true);
  });

  it('a platform-flagged out-of-stock line is excluded from items but kept in the stock lists', async () => {
    const r = await api.calculateCart([bothLine(1, { inStock: false })], undefined, 'blinkit');
    expect(r[0].outOfStockProductIds).toEqual(['blinkit-1']);
    expect(r[0].items).toEqual([]);
  });
});

describe('calculateCart: Blinkit', () => {
  const live = {
    subtotal: 80, deliveryFee: 25, handlingFee: 4, smallCartFee: 0, surgeFee: 3, surgeLabel: 'Rain', freeDeliveryGap: 20, tax: 2, total: 114,
    liveBill: true, outOfStockProductIds: [], inStockProductIds: ['blinkit-1'],
  };

  it('uses the live bill from the pricing service', async () => {
    await storage.saveToken('blinkit', 'tok');
    priceBlinkit.mockResolvedValue(live);
    const r = await api.calculateCart([bothLine(2)], undefined, 'blinkit');
    expect(r[0]).toMatchObject({ subtotal: 80, deliveryFee: 25, handlingFee: 4, surgeFee: 3, surgeLabel: 'Rain', tax: 2, total: 114, live: true, freeDeliveryGap: 20 });
    const input = priceBlinkit.mock.calls[0][0];
    expect(input).toMatchObject({ token: 'tok', gpsLat: 22.3, gpsLng: 73.1, subtotal: 80, simulateNoAddress: false });
  });

  it('drops freeDeliveryGap when delivery is already free', async () => {
    await storage.saveToken('blinkit', 'tok');
    priceBlinkit.mockResolvedValue({ ...live, deliveryFee: 0 });
    expect((await api.calculateCart([bothLine(2)], undefined, 'blinkit'))[0].freeDeliveryGap).toBeUndefined();
  });

  it('passes the simulate-no-address debug flag', async () => {
    await storage.saveToken('blinkit', 'tok');
    await AsyncStorage.setItem('@blinkit_simulate_no_address', '1');
    priceBlinkit.mockResolvedValue(live);
    await api.calculateCart([bothLine(2)], undefined, 'blinkit');
    expect(priceBlinkit.mock.calls[0][0].simulateNoAddress).toBe(true);
  });

  it('reports out-of-stock lines returned by the bill and leaves them out of items', async () => {
    await storage.saveToken('blinkit', 'tok');
    priceBlinkit.mockResolvedValue({ ...live, outOfStockProductIds: ['blinkit-1'], inStockProductIds: [] });
    const r = await api.calculateCart([bothLine(1)], undefined, 'blinkit');
    expect(r[0].outOfStockProductIds).toEqual(['blinkit-1']);
    expect(r[0].items).toEqual([]);
  });

  it('keeps the baseline when pricing throws', async () => {
    await storage.saveToken('blinkit', 'tok');
    priceBlinkit.mockRejectedValue(new Error('boom'));
    const r = await api.calculateCart([bothLine(2)], undefined, 'blinkit');
    expect(r[0]).toMatchObject({ live: false, subtotal: 80, total: 80 });
  });

  it('does not call the bill without a token or location, or with an empty subtotal', async () => {
    await api.calculateCart([bothLine(2)], undefined, 'blinkit');
    await storage.saveToken('blinkit', 'tok');
    await AsyncStorage.removeItem('@user_location');
    await api.calculateCart([bothLine(2)], undefined, 'blinkit');
    await storage.saveLocation({ latitude: 1, longitude: 2 });
    await api.calculateCart([], undefined, 'blinkit');
    expect(priceBlinkit).not.toHaveBeenCalled();
  });
});

describe('calculateCart: Swiggy live bill', () => {
  beforeEach(async () => { await storage.saveToken('swiggy', 'ck'); });

  const okCart = (items: any[], over: any = {}, billOver: any = {}) =>
    res(cartResp({ items, ...over }, billOver));

  it('posts the basket bound to the delivery address and reads every fee off the bill', async () => {
    swiggyRoute(() => okCart([{ productId: 'prod9', itemId: 'item9', quantity: 2, storeId: 'S1', name: 'Tata Salt' }]));
    const [c] = await api.calculateCart([swiggyLine()], undefined, 'swiggy');
    expect(c).toMatchObject({ live: true, subtotal: 100, total: 160, tax: 5, deliveryFee: 30, handlingFee: 15 });
    expect(c.inStockProductIds).toEqual(['swiggy-9']);
    expect(c.outOfStockProductIds).toEqual([]);
    const body = posts()[0].body;
    expect(body).toMatchObject({ source: 'userInitiated', data: { cartType: 'INSTAMART', addressId: 'addr1', location: DELIVERY.location } });
    expect(body.data.cartMetaData).toMatchObject({ preferredAddressId: 'addr1', primaryStoreId: 'S1', storeIds: ['S1'] });
    expect(body.data.items[0]).toMatchObject({ productId: 'prod9', itemId: 'item9', spin: 'sp9', quantity: 2 });
    expect(posts()).toHaveLength(1); // fast path: no search/v2
  });

  it('clamps the posted quantity to the item stock limit', async () => {
    swiggyRoute(() => okCart([{ productId: 'prod9', itemId: 'item9', quantity: 3, storeId: 'S1' }]));
    await api.calculateCart([swiggyLine({ availableStock: 3 }, 9)], undefined, 'swiggy');
    expect(posts()[0].body.data.items[0].quantity).toBe(3);
  });

  it('records the store the bill was actually priced at', async () => {
    swiggyRoute(() => okCart([{ productId: 'prod9', itemId: 'item9', quantity: 2, storeId: 'BILLSTORE' }]));
    await api.calculateCart([swiggyLine()], undefined, 'swiggy');
    await new Promise<void>(r => setImmediate(() => r()));
    expect(JSON.parse((await AsyncStorage.getItem('@swiggy_billed_store'))!)).toMatchObject({ locKey: '22.310,73.110', storeId: 'BILLSTORE' });
  });

  it('records per-item billed quantity and limit from the returned cart', async () => {
    swiggyRoute(() => okCart([{ productId: 'prod9', itemId: 'item9', quantity: 2, storeId: 'S1', inventory: { available_stock: 6 } }]));
    const [c] = await api.calculateCart([swiggyLine()], undefined, 'swiggy');
    expect(c.platformItemQuantities!['swiggy-9']).toBe(2);
    expect(c.platformItemLimits!['swiggy-9']).toBe(6);
  });

  it('infers a stock limit when swiggy bills fewer units than requested', async () => {
    swiggyRoute(() => okCart([{ productId: 'prod9', itemId: 'item9', quantity: 1, storeId: 'S1' }]));
    const [c] = await api.calculateCart([swiggyLine({}, 4)], undefined, 'swiggy');
    expect(c.platformItemLimits!['swiggy-9']).toBe(1);
    expect(c.platformItemQuantities!['swiggy-9']).toBe(1);
  });

  it('marks an item swiggy returns as out of stock', async () => {
    swiggyRoute(() => okCart([
      { productId: 'prod9', itemId: 'item9', quantity: 2, storeId: 'S1', name: 'Tata Salt' },
      { productId: 'prodB', itemId: 'itemB', quantity: 1, storeId: 'S1', name: 'Bread', inStock: false },
    ]));
    const lines = [swiggyLine(), swiggyLine({ id: 'swiggy-B', title: 'Bread', originalId: 'itemB', productId: 'prodB' }, 1)];
    const [c] = await api.calculateCart(lines, undefined, 'swiggy');
    expect(c.inStockProductIds).toEqual(['swiggy-9']);
    expect(c.outOfStockProductIds).toEqual(['swiggy-B']);
    expect(c.platformItemLimits!['swiggy-B']).toBe(0);
    expect(c.items.map(i => i.product.id)).toEqual(['swiggy-9']);
  });

  it('rebuilds via fresh search when an item we sent comes back in unavailableItems, and drops the unfindable one', async () => {
    // Fresh search only knows Tata Salt, so Bread ends up out of stock.
    jest.spyOn(api, 'searchSingle').mockImplementation(async (_p, q) => (q.includes('Salt')
      ? [{ id: 'swiggy-n', title: 'Tata Salt', brand: 'Instamart', quantity: '1 kg', price: 50, imageUrl: '', platform: 'swiggy', originalId: 'item9', productId: 'prod9' } as any]
      : []));
    swiggyRoute(() => okCart(
      [{ productId: 'prod9', itemId: 'item9', quantity: 2, storeId: 'S1' }],
      { unavailableItems: [{ productId: 'prodB', name: 'Bread' }] },
    ));
    const lines = [swiggyLine(), swiggyLine({ id: 'swiggy-B', title: 'Bread', originalId: 'itemB', productId: 'prodB' }, 1)];
    const [c] = await api.calculateCart(lines, undefined, 'swiggy');
    expect(posts()).toHaveLength(2);
    expect(posts()[1].body.data.items.map((i: any) => i.productId)).toEqual(['prod9']);
    expect(c.inStockProductIds).toEqual(['swiggy-9']);
    expect(c.outOfStockProductIds).toEqual(['swiggy-B']);
  });

  it('never bills or sends a line the catalog already flags unavailable', async () => {
    swiggyRoute(() => okCart([{ productId: 'prod9', itemId: 'item9', quantity: 2, storeId: 'S1' }]));
    const lines = [swiggyLine(), swiggyLine({ id: 'swiggy-X', title: 'Gone', originalId: 'iX', productId: 'pX', inStock: false }, 1)];
    const [c] = await api.calculateCart(lines, undefined, 'swiggy');
    expect(posts()[0].body.data.items.map((i: any) => i.productId)).toEqual(['prod9']);
    expect(c.outOfStockProductIds).toEqual(['swiggy-X']);
    expect(c.subtotal).toBe(100);
  });

  it('does not post at all when every swiggy line is known unavailable', async () => {
    swiggyRoute(() => okCart([]));
    const [c] = await api.calculateCart([swiggyLine({ inStock: false }, 1)], undefined, 'swiggy');
    expect(posts()).toHaveLength(0);
    expect(c.live).toBe(false);
    expect(c.outOfStockProductIds).toEqual(['swiggy-9']);
  });

  it('treats a single in-basket item as in stock when the live bill has a subtotal and nothing is flagged', async () => {
    swiggyRoute(() => okCart([]));
    const [c] = await api.calculateCart([swiggyLine()], undefined, 'swiggy');
    expect(c.live).toBe(true);
    expect(c.inStockProductIds).toEqual(['swiggy-9']);
  });

  it('refetches the cart when the POST response has no bill/items', async () => {
    swiggyRoute((url, method) => {
      if (method === 'POST') return res({ data: { data: { cartId: 'C' } } });
      return okCart([{ productId: 'prod9', itemId: 'item9', quantity: 2, storeId: 'S1' }]);
    });
    const [c] = await api.calculateCart([swiggyLine()], undefined, 'swiggy');
    expect(calls.some(x => x.method === 'GET' && x.url.includes('INSTAMART_CART'))).toBe(true);
    expect(c).toMatchObject({ live: true, total: 160 });
  });

  it('derives the subtotal from cart items when the bill has none', async () => {
    swiggyRoute(() => res({ data: { data: { cartId: 'C', bill: { toPay: '100', gst: '0' }, items: [{ productId: 'prod9', itemId: 'item9', quantity: 2, storeId: 'S1', finalPrice: 40 }] } } }));
    const [c] = await api.calculateCart([swiggyLine()], undefined, 'swiggy');
    expect(c.total).toBe(100);
    expect(c.live).toBe(true);
  });

  it('warns when the bill was priced for a different address', async () => {
    const warn = jest.spyOn(console, 'warn');
    swiggyRoute(() => okCart([{ productId: 'prod9', itemId: 'item9', quantity: 2, storeId: 'S1' }], { addressId: 'other' }));
    await api.calculateCart([swiggyLine()], undefined, 'swiggy');
    expect(warn.mock.calls.some(c => String(c[0]).includes('MISMATCH'))).toBe(true);
  });

  it('reads stock from cart warning messages', async () => {
    swiggyRoute(() => okCart(
      [{ productId: 'prod9', itemId: 'item9', quantity: 2, storeId: 'S1' }],
      { warnings: [{ productId: 'prod9', message: 'Only 3 units available' }] },
    ));
    const [c] = await api.calculateCart([swiggyLine()], undefined, 'swiggy');
    expect(c.platformItemLimits!['prod9']).toBe(3);
  });
});

describe('calculateCart: Swiggy rejection and retry', () => {
  beforeEach(async () => { await storage.saveToken('swiggy', 'ck'); });
  const good = () => res(cartResp({ items: [{ productId: 'prod9', itemId: 'item9', quantity: 2, storeId: 'S1' }] }));

  it('on a stock rejection, clamps quantities to the reported stock and reposts', async () => {
    let n = 0;
    swiggyRoute((url, method) => {
      if (method !== 'POST') return good();
      return ++n === 1 ? res({ message: 'Only 2 units available for Tata Salt' }, false) : good();
    });
    const [c] = await api.calculateCart([swiggyLine({}, 6)], undefined, 'swiggy');
    expect(posts()).toHaveLength(2);
    expect(posts()[1].body.data.items[0].quantity).toBe(2);
    expect(c.platformItemLimits!['item9']).toBe(2);
    expect(c.live).toBe(true);
  });

  it('on a non-stock rejection, retries once with the store id duplicated', async () => {
    let n = 0;
    swiggyRoute((url, method) => (method !== 'POST' ? good() : ++n === 1 ? res('nope', false) : good()));
    const [c] = await api.calculateCart([swiggyLine()], undefined, 'swiggy');
    expect(posts()).toHaveLength(2);
    expect(posts()[1].body.data.cartMetaData.storeIds).toEqual(['S1', 'S1']);
    expect(c.live).toBe(true);
  });

  it('rebuilds the basket from a fresh search when the stored ids are rejected', async () => {
    const searchSingle = jest.spyOn(api, 'searchSingle').mockResolvedValue([
      { id: 'swiggy-n', title: 'Tata Salt', brand: 'Instamart', quantity: '1 kg', price: 50, imageUrl: '', platform: 'swiggy', originalId: 'newI', productId: 'newP', spinId: 'newS' } as any,
    ]);
    swiggyRoute((url, method, body) => {
      if (method !== 'POST') return res({});
      const first = body.data.items[0].productId === 'prod9';
      // stale ids: reject both attempts; fresh ids: accept
      return first ? res('stale', false) : res(cartResp({ items: [{ productId: 'newP', itemId: 'newI', quantity: 2, storeId: 'S1' }] }));
    });
    const [c] = await api.calculateCart([swiggyLine()], undefined, 'swiggy');
    expect(searchSingle).toHaveBeenCalled();
    expect(posts().some(p => p.body.data.items[0].productId === 'newP')).toBe(true);
    expect(c.live).toBe(true);
    expect(c.inStockProductIds).toEqual(['swiggy-9']);
  });

  it('uses a fresh search directly for a line with no stored ids', async () => {
    jest.spyOn(api, 'searchSingle').mockResolvedValue([
      { id: 'swiggy-n', title: 'Tata Salt', brand: 'Instamart', quantity: '1 kg', price: 50, imageUrl: '', platform: 'swiggy', originalId: 'newI', productId: 'newP' } as any,
    ]);
    swiggyRoute(() => res(cartResp({ items: [{ productId: 'newP', itemId: 'newI', quantity: 2, storeId: 'S1' }] })));
    const line = { product: product({ id: 'swiggy-n', platform: 'swiggy', title: 'Tata Salt', price: 50 }), quantity: 2 }; // no ids
    const [c] = await api.calculateCart([line], undefined, 'swiggy');
    expect(posts()[0].body.data.items[0]).toMatchObject({ productId: 'newP', itemId: 'newI' });
    expect(c.live).toBe(true);
  });

  it('when search finds none of the lines, nothing is posted and the baseline stays non-live', async () => {
    // NOTE: current behaviour — the baseline classifier then lists the line as in stock (priced at its
    // search price, live=false) rather than out of stock; the UI shows "pricing unavailable" for non-live.
    jest.spyOn(api, 'searchSingle').mockResolvedValue([]);
    swiggyRoute(() => res({}));
    const line = { product: product({ id: 'swiggy-n', platform: 'swiggy', title: 'Mystery', price: 50 }), quantity: 1 };
    const [c] = await api.calculateCart([line], undefined, 'swiggy');
    expect(posts()).toHaveLength(0);
    expect(c.live).toBe(false);
    expect(c.subtotal).toBe(50);
  });

  it('when only some lines are found by search, the unfound one is out of stock', async () => {
    jest.spyOn(api, 'searchSingle').mockImplementation(async (_p, q) => (q.includes('Salt')
      ? [{ id: 'swiggy-n', title: 'Tata Salt', brand: 'Instamart', quantity: '1 kg', price: 50, imageUrl: '', platform: 'swiggy', originalId: 'newI', productId: 'newP' } as any]
      : []));
    swiggyRoute(() => res(cartResp({ items: [{ productId: 'newP', itemId: 'newI', quantity: 1, storeId: 'S1' }] })));
    const lines = [
      { product: product({ id: 'swiggy-s', platform: 'swiggy', title: 'Tata Salt', price: 50, quantity: '1 kg' }), quantity: 1 },
      { product: product({ id: 'swiggy-m', platform: 'swiggy', title: 'Mystery', price: 20 }), quantity: 1 },
    ];
    const [c] = await api.calculateCart(lines, undefined, 'swiggy');
    expect(c.live).toBe(true);
    expect(c.inStockProductIds).toEqual(['swiggy-s']);
    expect(c.outOfStockProductIds).toEqual(['swiggy-m']);
  });
});

describe('calculateCart: Swiggy store discovery', () => {
  beforeEach(async () => {
    await storage.saveToken('swiggy', 'ck');
    await AsyncStorage.removeItem('@swiggy_store_cache');
  });
  const accept = () => res(cartResp({ items: [{ productId: 'prod9', itemId: 'item9', quantity: 2, storeId: 'S9' }] }));

  it('discovers the store from home/v2 and caches it', async () => {
    swiggyRoute((url, method) => (url.includes('/home/v2') ? res({ data: { storeId: 'S9' } }) : accept()));
    const [c] = await api.calculateCart([swiggyLine()], undefined, 'swiggy');
    expect(calls[0].url).toContain('lat=22.310000');
    expect(c.live).toBe(true);
    expect(JSON.parse((await AsyncStorage.getItem('@swiggy_store_cache'))!).storeInfo.storeId).toBe('S9');
  });

  it('falls back to the session cart for the store (and shipment id)', async () => {
    swiggyRoute((url, method) => {
      if (url.includes('/home/v2')) return res({}, false);
      if (method === 'GET') return res({ data: { data: { deliveryType: 'SCHEDULED', items: [{ storeId: 555, shipmentIdV2: 'ship1' }] } } });
      return accept();
    });
    const [c] = await api.calculateCart([swiggyLine()], undefined, 'swiggy');
    expect(c.live).toBe(true);
    const body = posts()[0].body.data;
    expect(body.cartMetaData.primaryStoreId).toBe('555');
    expect(body.cartMetaData.deliveryType).toBe('SCHEDULED');
    expect(body.items[0].shipmentIdV2).toBe('ship1');
  });

  it('does not price when no store can be found', async () => {
    const warn = jest.spyOn(console, 'warn');
    swiggyRoute(() => res({}, false));
    const [c] = await api.calculateCart([swiggyLine()], undefined, 'swiggy');
    expect(posts()).toHaveLength(0);
    expect(c).toMatchObject({ live: false, subtotal: 100, total: 100 });
    expect(warn.mock.calls.some(x => String(x[0]).includes('could not discover'))).toBe(true);
  });

  it('keeps the baseline when the network layer throws', async () => {
    swiggyRoute(() => { throw new Error('bridge down'); });
    const [c] = await api.calculateCart([swiggyLine()], undefined, 'swiggy');
    expect(c).toMatchObject({ live: false, subtotal: 100 });
  });

  it('needs a swiggy token and a location to price live', async () => {
    await storage.removeToken('swiggy');
    swiggyRoute(() => accept());
    await api.calculateCart([swiggyLine()], undefined, 'swiggy');
    expect(calls).toHaveLength(0);
  });
});
