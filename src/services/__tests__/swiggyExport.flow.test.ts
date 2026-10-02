import AsyncStorage from '@react-native-async-storage/async-storage';
import * as apiModule from '../api';
import { api } from '../api';
import { exportCartToSwiggy } from '../swiggyExport';
import { storage } from '../storage';
import { product, variant, calc } from './fixtures';

const res = (body: any, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const STORE = { storeId: 'S1', primaryStoreId: 'P1', secondaryStoreId: '', layoutId: 'L1' };
const HOME = { data: { storeId: 'S1', primaryStoreId: 'P1', layoutId: 'L1' } };

// A line already matched on Swiggy with stored ids (fast path).
const sline = (over: any = {}, quantity = 2) => ({
  product: product({ id: 'swiggy-9', platform: 'swiggy', originalId: 'item9', productId: 'prod9', spinId: 'spin9', ...over }),
  quantity,
});

type Router = (url: string, method: string, body?: string) => any;
let calls: { url: string; method: string; body?: string }[];

function route(router: Router) {
  calls = [];
  jest.spyOn(api, 'swiggyApiFetch').mockImplementation(async (url: string, method = 'GET', body?: string) => {
    calls.push({ url, method, body });
    return router(url, method, body);
  });
}

// Happy-path router: home gives store, cart reads echo what was last written.
function happy(extra: { cartAfter?: any[]; postOk?: boolean; failFirstPost?: boolean; oldCartId?: string } = {}) {
  let posts = 0;
  let last: any[] = [];
  route((url, method, body) => {
    if (url.includes('/home/v2')) return res(HOME);
    if (url.endsWith('/cart/clear')) return res({});
    if (url.includes('/checkout/v2/cart') && method === 'POST') {
      posts++;
      if (extra.failFirstPost && posts === 1) return res('err', false);
      if (extra.postOk === false) return res('err', false);
      last = JSON.parse(body!).data.items.map((i: any) => ({ productId: i.productId, quantity: i.quantity }));
      return res({ data: { data: { cartId: 'NEW' } } });
    }
    if (url.includes('/checkout/v2/cart')) {
      return res({ data: { data: { cartId: extra.oldCartId ?? 'OLD', items: extra.cartAfter ?? last } } });
    }
    return res({});
  });
}

beforeEach(async () => {
  await AsyncStorage.clear();
  await storage.saveToken('swiggy', 't');
  await storage.saveLocation({ latitude: 22.3, longitude: 73.1 });
  jest.spyOn(api, 'resolveSwiggyDeliveryAddress').mockResolvedValue({
    id: 'addr1', name: 'Home', location: { latitude: 22.31, longitude: 73.11 },
  });
});

describe('exportCartToSwiggy: happy path', () => {
  it('clears, writes the cart bound to the delivery address, and verifies it', async () => {
    happy();
    const r = await exportCartToSwiggy([sline()]);
    expect(r).toMatchObject({ verified: true, storeId: 'S1', cartId: 'NEW', oldCartId: 'OLD', missing: [], outOfStock: [], clamped: [] });
    expect(r!.items[0]).toMatchObject({ productId: 'prod9', itemId: 'item9', spinId: 'spin9', quantity: 2 });
    expect(r!.cartUrl).toMatch(/^https:\/\/www\.swiggy\.com\/instamart\/cart\?goCartSync=\d+$/);

    // order: (home) → read old cart → clear → write → verify
    const seq = calls.map(c => `${c.method} ${c.url.replace('https://www.swiggy.com/api/instamart/', '').split('?')[0]}`);
    expect(seq.indexOf('POST checkout/v2/cart/clear')).toBeGreaterThan(seq.indexOf('GET checkout/v2/cart'));
    expect(seq.indexOf('POST checkout/v2/cart')).toBeGreaterThan(seq.indexOf('POST checkout/v2/cart/clear'));
    expect(seq[seq.length - 1]).toBe('GET checkout/v2/cart');

    const payload = r!.writePayload;
    expect(payload.source).toBe('userInitiated');
    expect(payload.data).toMatchObject({
      cartType: 'INSTAMART',
      addressId: 'addr1',
      location: { latitude: 22.31, longitude: 73.11 },
    });
    expect(payload.data.cartMetaData).toMatchObject({ preferredAddressId: 'addr1', primaryStoreId: 'S1', storeIds: ['S1'] });
    expect(payload.data.items[0]).toMatchObject({ productId: 'prod9', itemId: 'item9', spin: 'spin9', quantity: 2, serviceLine: 'INSTAMART' });
  });

  it('prices the store lookup at the delivery address coordinates', async () => {
    happy();
    await exportCartToSwiggy([sline()]);
    const home = calls.find(c => c.url.includes('/home/v2'))!;
    expect(home.url).toContain('lat=22.310000');
    expect(home.url).toContain('lng=73.110000');
  });

  it('reuses the cached store for the same location (no home lookup)', async () => {
    await AsyncStorage.setItem('@swiggy_store_cache', JSON.stringify({
      locKey: '22.310,73.110', storeInfo: STORE, at: Date.now(), cartMetaData: { deliveryType: 'SCHEDULED' },
    }));
    happy();
    const r = await exportCartToSwiggy([sline()]);
    expect(calls.some(c => c.url.includes('/home/v2'))).toBe(false);
    expect(r!.writePayload.data.cartMetaData.deliveryType).toBe('SCHEDULED');
  });

  it('ignores a stale (>24h) or other-location store cache', async () => {
    await AsyncStorage.setItem('@swiggy_store_cache', JSON.stringify({
      locKey: '22.310,73.110', storeInfo: STORE, at: Date.now() - 25 * 3600 * 1000,
    }));
    happy();
    await exportCartToSwiggy([sline()]);
    expect(calls.some(c => c.url.includes('/home/v2'))).toBe(true);
  });
});

describe('exportCartToSwiggy: stock handling', () => {
  it('skips out-of-stock lines (flag, live bill, zero limit) and reports them', async () => {
    happy();
    const lines = [
      sline({ id: 'swiggy-a', title: 'A', inStock: false }),
      sline({ id: 'swiggy-b', title: 'B' }),
      sline({ id: 'swiggy-c', title: 'C', availableStock: 0 }),
      sline({ id: 'swiggy-d', title: 'D', originalId: 'd', productId: 'd' }),
    ];
    const r = await exportCartToSwiggy(lines, [calc('swiggy', { outOfStockProductIds: ['swiggy-b'] })]);
    expect(r!.outOfStock.map(o => o.name).sort()).toEqual(['A', 'B', 'C']);
    expect(r!.items.map(i => i.name)).toEqual(['D']);
  });

  it('clamps quantity to available stock and reports it', async () => {
    happy();
    const r = await exportCartToSwiggy([sline({ availableStock: 3 }, 7)]);
    expect(r!.items[0].quantity).toBe(3);
    expect(r!.clamped).toEqual([{ name: 'Tata Salt', requestedQty: 7, exportedQty: 3 }]);
  });

  it('uses the lower of stock and max-per-order', async () => {
    happy();
    const r = await exportCartToSwiggy([sline({ availableStock: 10, maxQuantity: 4 }, 9)]);
    expect(r!.items[0].quantity).toBe(4);
  });

  it('never exports a fractional or zero quantity', async () => {
    happy();
    const r = await exportCartToSwiggy([sline({}, 0)]);
    expect(r!.items[0].quantity).toBe(1);
  });

  it('does not treat a skipped line (no swiggy match) as out of stock — it is looked up fresh', async () => {
    // product is blinkit-only: no swiggy ids → fresh search path
    const spySearch = jest.spyOn(apiModule, 'extractSwiggySearchProducts').mockReturnValue([{}]);
    jest.spyOn(apiModule, 'pickInstamartCandidate').mockReturnValue({ productId: 'fp', itemId: 'fi', spinId: 'fs', availableStock: 9 });
    route((url, method, body) => {
      if (url.includes('/home/v2')) return res(HOME);
      if (url.includes('/search/v2')) return res({ any: 1 });
      if (url.endsWith('/cart/clear')) return res({});
      if (method === 'POST') return res({ data: { data: { cartId: 'N' } } });
      return res({ data: { data: { items: [{ productId: 'fp', quantity: 2 }] } } });
    });
    const r = await exportCartToSwiggy([{ product: product({ id: 'blinkit-7' }), quantity: 2 }]);
    expect(spySearch).toHaveBeenCalled();
    expect(r!.outOfStock).toEqual([]);
    expect(r!.items[0]).toMatchObject({ productId: 'fp', itemId: 'fi', spinId: 'fs', quantity: 2 });
    expect(r!.verified).toBe(true);
  });
});

describe('exportCartToSwiggy: unmatched lines', () => {
  it('reports a line with no Swiggy match as missing, not out of stock, even if the bill lists it unavailable', async () => {
    happy();
    const blinkitOnly = { product: product({ id: 'blinkit-7', title: 'Only on Blinkit' }), quantity: 1 };
    const r = await exportCartToSwiggy([sline(), blinkitOnly], [calc('swiggy', { outOfStockProductIds: ['blinkit-7'] })]);
    expect(r!.outOfStock).toEqual([]);
    expect(r!.missing.map(m => m.name)).toEqual(['Only on Blinkit']);
    expect(r!.items).toHaveLength(1);
  });
});

describe('exportCartToSwiggy: fresh search fallback', () => {
  const blOnly = () => [{ product: product({ id: 'blinkit-7', title: 'Milk', quantity: '1 L' }), quantity: 3 }];
  const searchRouter = (searchBody: any) => route((url, method) => {
    if (url.includes('/home/v2')) return res(HOME);
    if (url.includes('/search/v2')) return searchBody;
    if (url.endsWith('/cart/clear')) return res({});
    if (method === 'POST') return res({ data: { data: { cartId: 'N' } } });
    return res({ data: { data: { items: [] } } });
  });

  it('reports the line as missing when search finds nothing', async () => {
    jest.spyOn(apiModule, 'extractSwiggySearchProducts').mockReturnValue([]);
    jest.spyOn(apiModule, 'pickInstamartCandidate').mockReturnValue(null);
    searchRouter(res({}));
    const r = await exportCartToSwiggy(blOnly());
    expect(r!.missing).toEqual([{ name: 'Milk', quantity: '1 L' }]);
    expect(r!.items).toEqual([]);
    expect(r!.cartUrl).toBe('');
    expect(r!.verified).toBe(false);
    expect(calls.some(c => c.url.endsWith('/cart/clear'))).toBe(false); // nothing to write → don't wipe the user's cart
  });

  it('reports missing when the search request fails or returns non-ok', async () => {
    searchRouter(res({}, false));
    expect((await exportCartToSwiggy(blOnly()))!.missing).toHaveLength(1);
  });

  it('marks a searched item out of stock when found with zero stock', async () => {
    jest.spyOn(apiModule, 'extractSwiggySearchProducts').mockReturnValue([{}]);
    jest.spyOn(apiModule, 'pickInstamartCandidate').mockReturnValue({ productId: 'p', itemId: 'i', availableStock: 0 });
    searchRouter(res({}));
    const r = await exportCartToSwiggy(blOnly());
    expect(r!.outOfStock).toEqual([{ name: 'Milk', quantity: '1 L' }]);
    expect(r!.items).toEqual([]);
  });

  it('clamps a searched item to the stock found by search', async () => {
    jest.spyOn(apiModule, 'extractSwiggySearchProducts').mockReturnValue([{}]);
    jest.spyOn(apiModule, 'pickInstamartCandidate').mockReturnValue({ productId: 'p', itemId: 'i', availableStock: 5, maxQuantity: 2 });
    searchRouter(res({}));
    const r = await exportCartToSwiggy(blOnly());
    expect(r!.items[0].quantity).toBe(2);
    expect(r!.clamped).toEqual([{ name: 'Milk', requestedQty: 3, exportedQty: 2 }]);
  });

  it('falls back to the productId/itemId of whichever the candidate has', async () => {
    jest.spyOn(apiModule, 'extractSwiggySearchProducts').mockReturnValue([{}]);
    jest.spyOn(apiModule, 'pickInstamartCandidate').mockReturnValue({ itemId: 'only-item' });
    searchRouter(res({}));
    const r = await exportCartToSwiggy(blOnly());
    expect(r!.items[0]).toMatchObject({ productId: 'only-item', itemId: 'only-item', spinId: '' });
  });
});

describe('exportCartToSwiggy: store discovery fallbacks', () => {
  it('falls back to the session cart when the home lookup fails', async () => {
    route((url, method, body) => {
      if (url.includes('/home/v2')) return res({}, false);
      if (url.endsWith('/cart/clear')) return res({});
      if (method === 'POST') return res({ data: { data: { cartId: 'N' } } });
      return res({ data: { data: { cartId: 'OLD', deliveryType: 'SCHEDULED', metadata: { values: { contactless_delivery: true } }, items: [{ storeId: 555, shipmentIdV2: 'ship1', productId: 'prod9', quantity: 2 }] } } });
    });
    const r = await exportCartToSwiggy([sline()]);
    expect(r!.storeId).toBe('555');
    expect(r!.shipmentIdV2).toBe('ship1');
    expect(r!.writePayload.data.cartMetaData.deliveryType).toBe('SCHEDULED');
    expect(r!.writePayload.data.items[0].shipmentIdV2).toBe('ship1');
  });

  it('returns items but writes nothing and cannot verify when no store can be found', async () => {
    route(() => res({}, false));
    const r = await exportCartToSwiggy([sline()]);
    expect(r!.storeId).toBeNull();
    expect(r!.verified).toBe(false);
    expect(calls.some(c => c.method === 'POST' && !c.url.endsWith('/clear') && c.url.includes('/checkout/v2/cart') && !c.url.endsWith('/cart/clear'))).toBe(false);
  });

  it('tolerates the bridge throwing during discovery', async () => {
    route(() => { throw new Error('bridge down'); });
    const r = await exportCartToSwiggy([sline()]);
    expect(r!.verified).toBe(false);
    expect(r!.storeId).toBeNull();
  });
});

describe('exportCartToSwiggy: write and verify', () => {
  it('retries the write once when the first POST is rejected', async () => {
    happy({ failFirstPost: true });
    const r = await exportCartToSwiggy([sline()]);
    const writes = calls.filter(c => c.method === 'POST' && !c.url.endsWith('/clear'));
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1].body!).data.cartMetaData.storeIds).toEqual(['S1', 'S1']);
    expect(r!.verified).toBe(true);
  });

  it('is not verified when the write is rejected twice', async () => {
    happy({ postOk: false });
    const r = await exportCartToSwiggy([sline()]);
    expect(r!.verified).toBe(false);
    expect(r!.cartId).toBeNull();
    expect(calls.filter(c => c.method === 'GET' && c.url.includes('checkout/v2/cart')).length).toBe(1); // only the pre-clear read; no verify read
  });

  it('is not verified when the committed cart differs (missing line or wrong quantity)', async () => {
    happy({ cartAfter: [{ productId: 'prod9', quantity: 1 }] });
    expect((await exportCartToSwiggy([sline({}, 2)]))!.verified).toBe(false);
    happy({ cartAfter: [] });
    expect((await exportCartToSwiggy([sline()]))!.verified).toBe(false);
  });

  it('is not verified when the committed cart has extra lines', async () => {
    happy({ cartAfter: [{ productId: 'prod9', quantity: 2 }, { productId: 'zzz', quantity: 1 }] });
    expect((await exportCartToSwiggy([sline()]))!.verified).toBe(false);
  });

  it('still writes if clearing the old cart throws', async () => {
    route((url, method, body) => {
      if (url.includes('/home/v2')) return res(HOME);
      if (url.endsWith('/cart/clear')) throw new Error('clear failed');
      if (method === 'POST') return res({ data: { data: { cartId: 'N' } } });
      return res({ data: { data: { items: [{ productId: 'prod9', quantity: 2 }] } } });
    });
    const r = await exportCartToSwiggy([sline()]);
    expect(r!.cartId).toBe('N');
    expect(r!.verified).toBe(true);
  });

  it('survives an unparseable post response and cart read', async () => {
    route((url, method) => {
      if (url.includes('/home/v2')) return res(HOME);
      if (url.endsWith('/cart/clear')) return res({});
      if (method === 'POST') return res('not json');
      return res('not json');
    });
    const r = await exportCartToSwiggy([sline()]);
    expect(r!.cartId).toBeNull();
    expect(r!.verified).toBe(false);
    expect(r!.oldCartId).toBe('');
  });

  it('exports several lines in one write', async () => {
    happy();
    const r = await exportCartToSwiggy([
      sline({ id: 'swiggy-1', originalId: 'i1', productId: 'p1' }),
      sline({ id: 'swiggy-2', originalId: 'i2', productId: 'p2' }, 3),
    ]);
    expect(r!.items.map(i => [i.productId, i.quantity])).toEqual([['p1', 2], ['p2', 3]]);
    expect(r!.verified).toBe(true);
  });
});

describe('exportCartToSwiggy: guards', () => {
  it('throws when Instamart does not serve the area (no delivery id)', async () => {
    (api.resolveSwiggyDeliveryAddress as jest.Mock).mockResolvedValue({ id: '', name: null, location: null });
    await expect(exportCartToSwiggy([sline()])).rejects.toThrow(/not available in this area/);
  });

  it('with an empty cart returns an empty result without touching the network', async () => {
    happy();
    const r = await exportCartToSwiggy([]);
    expect(r).toMatchObject({ items: [], verified: false, cartUrl: '' });
    expect(calls).toHaveLength(0);
  });

  it('falls back to GPS coordinates when the delivery address has no location', async () => {
    (api.resolveSwiggyDeliveryAddress as jest.Mock).mockResolvedValue({ id: 'a', name: null, location: null });
    happy();
    const r = await exportCartToSwiggy([sline()]);
    expect(calls.find(c => c.url.includes('/home/v2'))!.url).toContain('lat=22.300000');
    expect(r!.writePayload.data.location).toEqual({ latitude: 22.3, longitude: 73.1 });
  });
});
