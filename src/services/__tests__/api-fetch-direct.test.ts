// Tests the search paths of api.fetchDirectAPI (Blinkit bridge/direct fallback,
// Swiggy store discovery/caching). Modules are re-required per test because the
// Blinkit search keeps module-level cache / queue / challenge-cooldown state.
jest.mock('../blinkitBridge', () => ({
  requestViaBlinkitBridge: jest.fn(),
  isBlinkitBridgeConnected: jest.fn(() => true),
  waitForBlinkitBridge: jest.fn(async () => true),
}));
jest.mock('../swiggyBridge', () => ({
  requestViaSwiggyBridge: jest.fn(),
  requestEvalViaSwiggyBridge: jest.fn(),
}));

let AsyncStorage: typeof import('@react-native-async-storage/async-storage').default;
let api: typeof import('../api').api;
let bb: jest.Mocked<typeof import('../blinkitBridge')>;

const LOC = { latitude: 22.3, longitude: 73.1 };
const blinkitJson = (name = 'Amul Butter', id = 123) => ({ layout: [{ data: { name: { text: name }, price: '₹58', mrp: '₹60', unit: '100 g', id } }] });
const swiggyJson = (name = 'Tata Salt', sku = 'SKU1') => ({
  data: { widgets: [{ productId: 'P1', displayName: name, variations: [{ displayName: name, skuId: sku, spinId: 'SP1', quantityDescription: '1 kg', price: { offerPrice: { units: '28' }, mrp: { units: '30' } }, storeId: 'S1' }] }] },
});
const resp = (body: any, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(async () => {
  jest.resetModules();
  const asm = require('@react-native-async-storage/async-storage');
  AsyncStorage = asm.default ?? asm;
  api = require('../api').api;
  bb = require('../blinkitBridge');
  bb.isBlinkitBridgeConnected.mockReturnValue(true);
  bb.waitForBlinkitBridge.mockResolvedValue(true);
  bb.requestViaBlinkitBridge.mockReset();
  require('../swiggyBridge').requestViaSwiggyBridge.mockReset().mockResolvedValue(null);
  await AsyncStorage.clear();
  await AsyncStorage.setItem('@blinkit_address_status', JSON.stringify({ status: 'in_range' }));
});

describe('Blinkit search', () => {
  it('searches through the bridge and maps products', async () => {
    bb.requestViaBlinkitBridge.mockResolvedValue({ status: 200, text: JSON.stringify(blinkitJson()) });
    const r = await api.fetchDirectAPI('blinkit', 'butter', 'tok', LOC);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ title: 'Amul Butter', price: 58, originalPrice: 60, platform: 'blinkit', quantity: '100 g', productId: '123', originalId: '123' });
    const [url, method, , headers] = bb.requestViaBlinkitBridge.mock.calls[0] as any;
    expect(url).toContain('actual_query=butter');
    expect(method).toBe('POST');
    expect(headers).toMatchObject({ auth_key: 'tok', lat: '22.3', lon: '73.1' });
  });

  it('searches at the saved Blinkit address coordinates, not raw GPS', async () => {
    await AsyncStorage.setItem('@blinkit_lat', '22.31');
    await AsyncStorage.setItem('@blinkit_lng', '73.11');
    bb.requestViaBlinkitBridge.mockResolvedValue({ status: 200, text: JSON.stringify(blinkitJson()) });
    await api.fetchDirectAPI('blinkit', 'milk', 'tok', LOC);
    expect((bb.requestViaBlinkitBridge.mock.calls[0] as any)[3]).toMatchObject({ lat: '22.31', lon: '73.11' });
  });

  it('ignores invalid saved coordinates', async () => {
    await AsyncStorage.setItem('@blinkit_lat', 'abc');
    await AsyncStorage.setItem('@blinkit_lng', '73.11');
    bb.requestViaBlinkitBridge.mockResolvedValue({ status: 200, text: JSON.stringify(blinkitJson()) });
    await api.fetchDirectAPI('blinkit', 'milk2', 'tok', LOC);
    expect((bb.requestViaBlinkitBridge.mock.calls[0] as any)[3]).toMatchObject({ lat: '22.3', lon: '73.1' });
  });

  it('waits for the bridge to connect before searching when it is not up yet', async () => {
    bb.isBlinkitBridgeConnected.mockReturnValue(false);
    bb.requestViaBlinkitBridge.mockResolvedValue({ status: 200, text: JSON.stringify(blinkitJson()) });
    await api.fetchDirectAPI('blinkit', 'eggs', 'tok', LOC);
    expect(bb.waitForBlinkitBridge).toHaveBeenCalledWith(5000);
  });

  it('does not wait when the bridge is already connected', async () => {
    bb.requestViaBlinkitBridge.mockResolvedValue({ status: 200, text: JSON.stringify(blinkitJson()) });
    await api.fetchDirectAPI('blinkit', 'eggs2', 'tok', LOC);
    expect(bb.waitForBlinkitBridge).not.toHaveBeenCalled();
  });

  it('serves an identical repeat search from cache (one bridge call)', async () => {
    bb.requestViaBlinkitBridge.mockResolvedValue({ status: 200, text: JSON.stringify(blinkitJson()) });
    await api.fetchDirectAPI('blinkit', 'curd', 'tok', LOC);
    await api.fetchDirectAPI('blinkit', 'curd', 'tok', LOC);
    expect(bb.requestViaBlinkitBridge).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight request between identical concurrent searches', async () => {
    bb.requestViaBlinkitBridge.mockResolvedValue({ status: 200, text: JSON.stringify(blinkitJson()) });
    const [a, b] = await Promise.all([
      api.fetchDirectAPI('blinkit', 'ghee', 'tok', LOC),
      api.fetchDirectAPI('blinkit', 'ghee', 'tok', LOC),
    ]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(bb.requestViaBlinkitBridge).toHaveBeenCalledTimes(1);
  });

  it('falls back to a direct request when the bridge returns nothing', async () => {
    bb.requestViaBlinkitBridge.mockResolvedValue(null);
    const fetchSpy = jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue(resp(blinkitJson('Direct Item')) as any);
    const r = await api.fetchDirectAPI('blinkit', 'rice', 'tok', LOC);
    expect(r[0].title).toBe('Direct Item');
    const [, opts] = fetchSpy.mock.calls[0] as any;
    expect(opts.method).toBe('POST');
    expect(opts.headers.auth_key).toBe('tok');
  });

  it('falls back to a direct request on an unparseable bridge body', async () => {
    bb.requestViaBlinkitBridge.mockResolvedValue({ status: 200, text: '<html>' });
    const fetchSpy = jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue(resp(blinkitJson()) as any);
    await api.fetchDirectAPI('blinkit', 'dal', 'tok', LOC);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('throws when the direct fallback also fails', async () => {
    bb.requestViaBlinkitBridge.mockResolvedValue(null);
    jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue(resp({}, false, 503) as any);
    await expect(api.fetchDirectAPI('blinkit', 'atta', 'tok', LOC)).rejects.toThrow('Blinkit API error: 503');
  });

  it('after a Cloudflare challenge, stops hitting the bridge for a cooldown and goes straight to direct', async () => {
    bb.requestViaBlinkitBridge.mockResolvedValue({ status: 403, text: 'Just a moment...' });
    const fetchSpy = jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue(resp(blinkitJson()) as any);
    await api.fetchDirectAPI('blinkit', 'sugar', 'tok', LOC);
    expect(bb.requestViaBlinkitBridge).toHaveBeenCalledTimes(1); // no retries on a challenge
    await api.fetchDirectAPI('blinkit', 'tea', 'tok', LOC);
    expect(bb.requestViaBlinkitBridge).toHaveBeenCalledTimes(1); // cooldown: bridge skipped
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-429 errors on the bridge', async () => {
    bb.requestViaBlinkitBridge.mockResolvedValue({ status: 500, text: 'err' });
    jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue(resp(blinkitJson()) as any);
    await api.fetchDirectAPI('blinkit', 'oil', 'tok', LOC);
    expect(bb.requestViaBlinkitBridge).toHaveBeenCalledTimes(1);
  });

  it('retries a plain 429 with backoff and succeeds', async () => {
    jest.useFakeTimers();
    bb.requestViaBlinkitBridge
      .mockResolvedValueOnce({ status: 429, text: 'slow down' })
      .mockResolvedValueOnce({ status: 200, text: JSON.stringify(blinkitJson()) });
    const p = api.fetchDirectAPI('blinkit', 'poha', 'tok', LOC);
    await jest.advanceTimersByTimeAsync(2100);
    expect(await p).toHaveLength(1);
    expect(bb.requestViaBlinkitBridge).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('returns [] for a response with no products', async () => {
    bb.requestViaBlinkitBridge.mockResolvedValue({ status: 200, text: JSON.stringify({ nothing: true }) });
    expect(await api.fetchDirectAPI('blinkit', 'zzz', 'tok', LOC)).toEqual([]);
  });
});

describe('Swiggy search', () => {
  const STORE_CACHE = (over: any = {}) => JSON.stringify({ locKey: '22.310,73.110', at: Date.now(), storeInfo: { storeId: 'S1', primaryStoreId: 'P1', secondaryStoreId: '', layoutId: 'L1' }, ...over });
  const deliver = (api: any) => jest.spyOn(api, 'resolveSwiggyDeliveryAddress').mockResolvedValue({ id: 'a1', name: 'Home', location: { latitude: 22.31, longitude: 73.11 } });

  it('refuses when there is no deliverable address / out of range', async () => {
    jest.spyOn(api, 'resolveSwiggyDeliveryAddress').mockResolvedValue(null);
    await expect(api.fetchDirectAPI('swiggy', 'salt', 'ck', LOC)).rejects.toThrow(/SWIGGY_UNAVAILABLE/);
  });

  it.each(['too_far', 'no_address'])('refuses when the stored status is %s', async (status) => {
    deliver(api);
    await AsyncStorage.setItem('@swiggy_address_status', JSON.stringify({ status }));
    await expect(api.fetchDirectAPI('swiggy', 'salt', 'ck', LOC)).rejects.toThrow(/SWIGGY_UNAVAILABLE/);
  });

  it('uses the cached store and maps results', async () => {
    deliver(api);
    await AsyncStorage.setItem('@swiggy_store_cache', STORE_CACHE());
    const fetchSpy = jest.spyOn(api, 'swiggyApiFetch').mockResolvedValue(resp(swiggyJson()) as any);
    const r = await api.fetchDirectAPI('swiggy', 'salt', 'ck', LOC);
    expect(r[0]).toMatchObject({ title: 'Tata Salt', brand: 'Instamart', price: 28, originalPrice: 30, platform: 'swiggy', originalId: 'SKU1', spinId: 'SP1', quantity: '1 kg' });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // no home/v2 lookup
    const [url, method, body] = fetchSpy.mock.calls[0] as any;
    expect(url).toContain('search/v2');
    expect(url).toContain('storeId=S1');
    expect(url).toContain('layoutId=L1');
    expect(method).toBe('POST');
    expect(JSON.parse(body).query).toBe('salt');
  });

  it('discovers the store from home/v2 when not cached, and caches it', async () => {
    deliver(api);
    const fetchSpy = jest.spyOn(api, 'swiggyApiFetch').mockImplementation(async (url: string) =>
      (url.includes('/home/v2') ? resp({ data: { storeId: 'S9', layoutId: 'L9' } }) : resp(swiggyJson())) as any);
    await api.fetchDirectAPI('swiggy', 'salt', 'ck', LOC);
    expect((fetchSpy.mock.calls[0][0] as string)).toContain('lat=22.310000');
    expect(JSON.parse((await AsyncStorage.getItem('@swiggy_store_cache'))!).storeInfo.storeId).toBe('S9');
  });

  it("the bill's own store (last billed at this location) overrides the discovered one", async () => {
    deliver(api);
    await AsyncStorage.setItem('@swiggy_store_cache', STORE_CACHE());
    await AsyncStorage.setItem('@swiggy_billed_store', JSON.stringify({ locKey: '22.310,73.110', storeId: 'BILLED', at: Date.now() }));
    const fetchSpy = jest.spyOn(api, 'swiggyApiFetch').mockResolvedValue(resp(swiggyJson()) as any);
    await api.fetchDirectAPI('swiggy', 'salt', 'ck', LOC);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('storeId=BILLED');
    expect(url).toContain('primaryStoreId=BILLED');
  });

  it('ignores a billed-store record from another location or older than 24h', async () => {
    deliver(api);
    await AsyncStorage.setItem('@swiggy_store_cache', STORE_CACHE());
    const fetchSpy = jest.spyOn(api, 'swiggyApiFetch').mockResolvedValue(resp(swiggyJson()) as any);
    await AsyncStorage.setItem('@swiggy_billed_store', JSON.stringify({ locKey: 'other', storeId: 'X', at: Date.now() }));
    await api.fetchDirectAPI('swiggy', 'salt', 'ck', LOC);
    await AsyncStorage.setItem('@swiggy_billed_store', JSON.stringify({ locKey: '22.310,73.110', storeId: 'X', at: Date.now() - 25 * 3600 * 1000 }));
    await api.fetchDirectAPI('swiggy', 'salt', 'ck', LOC);
    for (const c of fetchSpy.mock.calls) expect(c[0]).toContain('storeId=S1');
  });

  it('falls back to the active cart store when home/v2 yields nothing', async () => {
    deliver(api);
    jest.spyOn(api, 'swiggyApiFetch').mockImplementation(async (url: string) => {
      if (url.includes('/home/v2')) return resp({}, false) as any;
      if (url.includes('checkout/v2/cart')) return resp({ data: { data: { items: [{ storeId: 777 }] } } }) as any;
      return resp(swiggyJson()) as any;
    });
    jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue(resp({}, false) as any);
    const r = await api.fetchDirectAPI('swiggy', 'salt', 'ck', LOC);
    expect(r).toHaveLength(1);
    expect(JSON.parse((await AsyncStorage.getItem('@swiggy_store_cache'))!).storeInfo.storeId).toBe('777');
  });

  it('falls back to any previously cached store as a last resort', async () => {
    deliver(api);
    await AsyncStorage.setItem('@swiggy_store_cache', STORE_CACHE({ locKey: 'elsewhere' }));
    jest.spyOn(api, 'swiggyApiFetch').mockImplementation(async (url: string) =>
      (url.includes('search/v2') ? resp(swiggyJson()) : resp({}, false)) as any);
    jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue(resp({}, false) as any);
    expect(await api.fetchDirectAPI('swiggy', 'salt', 'ck', LOC)).toHaveLength(1);
  });

  it('throws when no store can be found anywhere', async () => {
    deliver(api);
    jest.spyOn(api, 'swiggyApiFetch').mockResolvedValue(resp({}, false) as any);
    jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue(resp({}, false) as any);
    await expect(api.fetchDirectAPI('swiggy', 'salt', 'ck', LOC)).rejects.toThrow('No active Swiggy store ID');
  });

  it('retries the search directly with the cookie when the bridge call fails, then errors if that fails too', async () => {
    deliver(api);
    await AsyncStorage.setItem('@swiggy_store_cache', STORE_CACHE());
    jest.spyOn(api, 'swiggyApiFetch').mockResolvedValue(resp({}, false) as any);
    const direct = jest.spyOn(api, 'fetchWithTimeout').mockResolvedValueOnce(resp(swiggyJson()) as any);
    expect(await api.fetchDirectAPI('swiggy', 'salt', 'COOKIE', LOC)).toHaveLength(1);
    expect((direct.mock.calls[0][1] as any).headers.Cookie).toBe('COOKIE');
    direct.mockResolvedValueOnce(resp({}, false, 502) as any);
    await expect(api.fetchDirectAPI('swiggy', 'salt', 'COOKIE', LOC)).rejects.toThrow('Swiggy search/v2 API error: 502');
  });

  it('parses a search body that only exposes text()', async () => {
    deliver(api);
    await AsyncStorage.setItem('@swiggy_store_cache', STORE_CACHE());
    jest.spyOn(api, 'swiggyApiFetch').mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('no'); }, text: async () => JSON.stringify(swiggyJson()) } as any);
    expect(await api.fetchDirectAPI('swiggy', 'salt', 'ck', LOC)).toHaveLength(1);
  });

  it('returns [] for an unknown platform', async () => {
    expect(await api.fetchDirectAPI('zepto' as any, 'x', 't', LOC)).toEqual([]);
  });
});
