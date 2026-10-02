import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, invalidateAddressSessionCache } from '../api';
import { storage } from '../storage';
import * as swiggyBridge from '../swiggyBridge';

jest.mock('../swiggyBridge', () => ({
  requestViaSwiggyBridge: jest.fn(),
  requestEvalViaSwiggyBridge: jest.fn(),
}));
const bridged = swiggyBridge.requestViaSwiggyBridge as jest.Mock;
const evalBridge = swiggyBridge.requestEvalViaSwiggyBridge as jest.Mock;

const ok = (body: any) => ({ ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
const bad = () => ({ ok: false, status: 500, text: async () => '', json: async () => ({}) });

beforeEach(async () => {
  await AsyncStorage.clear();
  invalidateAddressSessionCache();
  bridged.mockReset();
  evalBridge.mockReset().mockResolvedValue(null);
});

describe('api.swiggyApiFetch', () => {
  it('uses the bridge response when it succeeds', async () => {
    bridged.mockResolvedValue({ status: 200, text: '{"a":1}' });
    const r: any = await api.swiggyApiFetch('https://x', 'POST', 'b');
    expect(bridged).toHaveBeenCalledWith('https://x', 'POST', 'b');
    expect(r.ok).toBe(true);
    expect(await r.json()).toEqual({ a: 1 });
    expect(await r.text()).toBe('{"a":1}');
  });

  it('falls back to a direct request with the cookie token when the bridge is unavailable or non-2xx', async () => {
    await storage.saveToken('swiggy', 'COOKIE');
    const fetchSpy = jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue({ ok: true } as any);
    bridged.mockResolvedValueOnce(null);
    await api.swiggyApiFetch('https://x');
    bridged.mockResolvedValueOnce({ status: 403, text: 'no' });
    await api.swiggyApiFetch('https://x', 'POST', '{"q":1}');
    const [, o1] = fetchSpy.mock.calls[0] as any;
    const [, o2, t] = fetchSpy.mock.calls[1] as any;
    expect(o1.headers.Cookie).toBe('COOKIE');
    expect(o1.body).toBeUndefined();
    expect(o2.method).toBe('POST');
    expect(o2.headers['Content-Type']).toBe('application/json');
    expect(o2.body).toBe('{"q":1}');
    expect(t).toBe(8000);
  });

  it('sends no Cookie header without a token', async () => {
    const fetchSpy = jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue({ ok: true } as any);
    bridged.mockResolvedValue(null);
    await api.swiggyApiFetch('https://x');
    expect((fetchSpy.mock.calls[0][1] as any).headers.Cookie).toBeUndefined();
  });
});

describe('api.getSwiggyAddresses', () => {
  const route = (map: Record<string, any>) =>
    jest.spyOn(api, 'swiggyApiFetch').mockImplementation(async (url: string) => {
      for (const k of Object.keys(map)) if (url.includes(k)) return map[k];
      return bad() as any;
    });

  it('returns [] when nothing responds', async () => {
    jest.spyOn(api, 'swiggyApiFetch').mockResolvedValue(bad() as any);
    expect(await api.getSwiggyAddresses(1, 2)).toEqual([]);
  });

  it('extracts addresses with coordinates and a tagged name from an address list endpoint', async () => {
    route({
      '/dapi/address/all': ok({ data: { addresses: [
        { id: 'a1', tag: 'Home', formatted_address: 'Alkapuri, Vadodara', location: { latitude: 22.3, longitude: 73.1 } },
      ] } }),
    });
    const r = await api.getSwiggyAddresses();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: 'a1', name: 'Home - Alkapuri, Vadodara', latitude: 22.3, longitude: 73.1, location: { latitude: 22.3, longitude: 73.1 }, source: 'dapi-all' });
  });

  it('does not repeat the tag when the address already starts with it', async () => {
    route({ '/dapi/address/all': ok({ addresses: [{ id: 'a', tag: 'Home', formatted_address: 'Home, MG Road', lat: 1, lng: 2 }] }) });
    expect((await api.getSwiggyAddresses())[0].name).toBe('Home, MG Road');
  });

  it('builds a name from address parts when there is no direct text, and falls back to the tag', async () => {
    route({
      '/dapi/address/all': ok({ addresses: [
        { id: 'p', address_line_1: '12 Park St', city: 'Vadodara', pincode: '390001', tag: 'Work', latitude: 22.3, longitude: 73.1 },
        { id: 't', tag: 'Other', latitude: 22.4, longitude: 73.2 },
      ] }),
    });
    const r = await api.getSwiggyAddresses();
    expect(r.find(a => a.id === 'p')!.name).toBe('Work - 12 Park St, Vadodara, 390001');
    expect(r.find(a => a.id === 't')!.name).toBe('Other');
  });

  it('parses coordinates from string, array and alternate shapes', async () => {
    route({
      '/dapi/address/all': ok({ addresses: [
        { id: 's', formatted_address: 'S', location: '22.3,73.1' },
        { id: 'j', formatted_address: 'J', location: '{"lat":22.4,"lng":73.2}' },
        { id: 'arr', formatted_address: 'A', location: [22.5, 73.3] },
        { id: 'rev', formatted_address: 'R', location: [105.4, 22.6] }, // lon,lat order (lon > 90 is unambiguous)
        { id: 'amb', formatted_address: 'M', location: [73.4, 22.6] }, // both ≤ 90: read as [lat, lon]
        { id: 'alt', formatted_address: 'L', annotation_point: { latitude: 22.7, longitude: 73.5 } },
        { id: 'num', formatted_address: 'N', coordinates: { lat: '22.8', lng: '73.6' } },
      ] }),
    });
    const r = await api.getSwiggyAddresses();
    const by = Object.fromEntries(r.map(a => [a.id, [a.latitude, a.longitude]]));
    expect(by).toEqual({ s: [22.3, 73.1], j: [22.4, 73.2], arr: [22.5, 73.3], rev: [22.6, 105.4], amb: [73.4, 22.6], alt: [22.7, 73.5], num: [22.8, 73.6] });
  });

  it('keeps an address with no coordinates but with a null location', async () => {
    route({ '/dapi/address/all': ok({ addresses: [{ id: 'nc', formatted_address: 'No coords' }] }) });
    const r = await api.getSwiggyAddresses();
    expect(r[0]).toMatchObject({ id: 'nc', location: null, latitude: undefined });
  });

  it('ignores products, widgets and store listings that merely look address-ish', async () => {
    route({ '/dapi/address/all': ok({ addresses: [
      { productId: 'p1', formatted_address: 'x', latitude: 1, longitude: 2 },
      { widget_type: 'W', pincode: '1' },
      { layoutId: 'L', city: 'c', area: 'a' },
      { random: true },
    ] }) });
    expect(await api.getSwiggyAddresses()).toEqual([]);
  });

  it('dedupes the same id across endpoints and fills missing coordinates from the later source', async () => {
    route({
      '/dapi/address/all': ok({ addresses: [{ id: 'd', formatted_address: 'Dup' }] }),
      '/dapi/address/list': ok({ addresses: [{ id: 'd', formatted_address: 'Dup', latitude: 22.3, longitude: 73.1 }] }),
    });
    const r = await api.getSwiggyAddresses();
    expect(r).toHaveLength(1);
    expect(r[0].latitude).toBe(22.3);
    expect(r[0].source).toContain('+');
  });

  it('pulls delivery addresses out of order history across pages and stops on an empty page', async () => {
    const page = (id: string, order: string, lat: number) => ({ data: { orders: [{ order_id: order, delivery_address: { id, formatted_address: id, latitude: lat, longitude: 73 } }] } });
    const seen: string[] = [];
    jest.spyOn(api, 'swiggyApiFetch').mockImplementation(async (url: string) => {
      if (!url.includes('/dapi/order/all')) return bad() as any;
      seen.push(url);
      if (!url.includes('order_id')) return ok(page('o1', 'ord1', 22.1)) as any;
      if (url.endsWith('ord1')) return ok(page('o2', 'ord2', 22.2)) as any;
      return ok({ data: { orders: [] } }) as any;
    });
    const r = await api.getSwiggyAddresses();
    expect(r.map(a => a.id).sort()).toEqual(['o1', 'o2']);
    expect(seen).toHaveLength(3);
  });

  it('stops paging when the last order id repeats (no infinite loop)', async () => {
    const spy = jest.spyOn(api, 'swiggyApiFetch').mockImplementation(async (url: string) =>
      (url.includes('/dapi/order/all') ? ok({ data: { orders: [{ order_id: 'same', delivery_address: { id: 'x', formatted_address: 'X', latitude: 1, longitude: 2 } }] } }) : bad()) as any);
    await api.getSwiggyAddresses();
    expect(spy.mock.calls.filter(c => String(c[0]).includes('/dapi/order/all')).length).toBeLessThanOrEqual(2);
  });

  it('recovers addresses from embedded JSON in an HTML page', async () => {
    route({ '/my-account/addresses': ok('<html><script>window.__INITIAL_STATE__ = {"addresses":[{"id":"h1","formatted_address":"Html Addr","latitude":22.3,"longitude":73.1}]};</script></html>') });
    const r = await api.getSwiggyAddresses();
    expect(r.map(a => a.id)).toEqual(['h1']);
  });

  it('adds addresses from the in-page bridge evaluation', async () => {
    jest.spyOn(api, 'swiggyApiFetch').mockResolvedValue(bad() as any);
    evalBridge.mockResolvedValue({ status: 200, text: JSON.stringify([{ id: 'e1', formatted_address: 'Eval', latitude: 22.3, longitude: 73.1 }]) });
    const r = await api.getSwiggyAddresses();
    expect(r).toEqual([expect.objectContaining({ id: 'e1', source: 'bridge-eval' })]);
  });

  it('survives endpoint exceptions and a throwing/garbage bridge eval', async () => {
    jest.spyOn(api, 'swiggyApiFetch').mockRejectedValue(new Error('down'));
    evalBridge.mockResolvedValue({ status: 200, text: 'garbage' });
    expect(await api.getSwiggyAddresses()).toEqual([]);
  });
});

describe('api.resolveSwiggyDeliveryAddress', () => {
  const A = (id: string, lat: number, lng: number, name = id) => ({ id, name, latitude: lat, longitude: lng, location: { latitude: lat, longitude: lng } });
  const status = async () => JSON.parse((await AsyncStorage.getItem('@swiggy_address_status')) || 'null');

  it('picks the closest in-range address and persists it', async () => {
    jest.spyOn(api, 'getSwiggyAddresses').mockResolvedValue([A('far', 22.6, 73.4), A('near', 22.301, 73.101, 'Home')]);
    const r = await api.resolveSwiggyDeliveryAddress(22.3, 73.1);
    expect(r).toMatchObject({ id: 'near', name: 'Home', location: { latitude: 22.301, longitude: 73.101 } });
    expect(await status()).toMatchObject({ status: 'in_range', addressId: 'near' });
    expect(await AsyncStorage.getItem('@swiggy_address_id')).toBe('near');
    expect(await AsyncStorage.getItem('@swiggy_lat')).toBe('22.301');
  });

  it('is too_far beyond 35 km and clears the stored address', async () => {
    await AsyncStorage.setItem('@swiggy_address_id', 'old');
    jest.spyOn(api, 'getSwiggyAddresses').mockResolvedValue([A('far', 23.3, 73.1, 'Far')]);
    expect(await api.resolveSwiggyDeliveryAddress(22.3, 73.1)).toBeNull();
    expect(await status()).toMatchObject({ status: 'too_far', name: 'Far' });
    expect(await AsyncStorage.getItem('@swiggy_address_id')).toBeNull();
  });

  it('is too_far when the only addresses have no coordinates', async () => {
    jest.spyOn(api, 'getSwiggyAddresses').mockResolvedValue([{ id: 'nc', name: 'NC', location: null }]);
    expect(await api.resolveSwiggyDeliveryAddress(22.3, 73.1)).toBeNull();
    expect((await status()).status).toBe('too_far');
  });

  it('prefers a located address over one without coordinates', async () => {
    jest.spyOn(api, 'getSwiggyAddresses').mockResolvedValue([{ id: 'nc', name: 'NC', location: null }, A('ok', 22.3, 73.1)]);
    expect((await api.resolveSwiggyDeliveryAddress(22.3, 73.1))!.id).toBe('ok');
  });

  it('records no_address and clears storage when there are none', async () => {
    await AsyncStorage.setItem('@swiggy_lat', '1');
    jest.spyOn(api, 'getSwiggyAddresses').mockResolvedValue([]);
    expect(await api.resolveSwiggyDeliveryAddress(22.3, 73.1)).toBeNull();
    expect(await status()).toEqual({ status: 'no_address' });
    expect(await AsyncStorage.getItem('@swiggy_lat')).toBeNull();
  });

  it('returns null if address discovery throws', async () => {
    jest.spyOn(api, 'getSwiggyAddresses').mockRejectedValue(new Error('x'));
    expect(await api.resolveSwiggyDeliveryAddress(22.3, 73.1)).toBeNull();
  });

  it('serves nearby repeats from the session cache; force refetches; far moves refetch', async () => {
    const spy = jest.spyOn(api, 'getSwiggyAddresses').mockResolvedValue([A('a', 22.3, 73.1)]);
    await api.resolveSwiggyDeliveryAddress(22.3, 73.1);
    expect((await api.resolveSwiggyDeliveryAddress(22.3005, 73.1))!.id).toBe('a');
    expect(spy).toHaveBeenCalledTimes(1);
    await api.resolveSwiggyDeliveryAddress(22.3, 73.1, true);
    expect(spy).toHaveBeenCalledTimes(2);
    await api.resolveSwiggyDeliveryAddress(22.4, 73.1);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('caches negative results in-session (too_far → null without refetch)', async () => {
    const spy = jest.spyOn(api, 'getSwiggyAddresses').mockResolvedValue([A('far', 23.3, 73.1)]);
    await api.resolveSwiggyDeliveryAddress(22.3, 73.1);
    expect(await api.resolveSwiggyDeliveryAddress(22.3, 73.1)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  describe('persistent cache', () => {
    const seed = (e: any) => AsyncStorage.setItem('@swiggy_address', JSON.stringify(e));

    it('restores an in_range entry without a network call', async () => {
      await seed({ id: 'c1', name: 'Home', location: { latitude: 22.3, longitude: 73.1 }, status: 'in_range', lat: 22.3, lng: 73.1, distanceKm: 0.1, at: Date.now() });
      const spy = jest.spyOn(api, 'getSwiggyAddresses');
      expect(await api.resolveSwiggyDeliveryAddress(22.3, 73.1)).toMatchObject({ id: 'c1', name: 'Home' });
      expect(spy).not.toHaveBeenCalled();
      expect(await status()).toMatchObject({ status: 'in_range', addressId: 'c1' });
    });

    it('restores too_far / no_address as null', async () => {
      const spy = jest.spyOn(api, 'getSwiggyAddresses');
      await seed({ status: 'too_far', lat: 22.3, lng: 73.1, distanceKm: 60, name: 'F', at: Date.now() });
      expect(await api.resolveSwiggyDeliveryAddress(22.3, 73.1)).toBeNull();
      invalidateAddressSessionCache();
      await seed({ status: 'no_address', lat: 22.3, lng: 73.1, at: Date.now() });
      expect(await api.resolveSwiggyDeliveryAddress(22.3, 73.1)).toBeNull();
      expect(await status()).toEqual({ status: 'no_address' });
      expect(spy).not.toHaveBeenCalled();
    });

    it('ignores stale or corrupt cache and refetches', async () => {
      const spy = jest.spyOn(api, 'getSwiggyAddresses').mockResolvedValue([]);
      await seed({ id: 'c1', status: 'in_range', lat: 22.3, lng: 73.1, at: Date.now() - 25 * 3600 * 1000 });
      await api.resolveSwiggyDeliveryAddress(22.3, 73.1);
      invalidateAddressSessionCache();
      await AsyncStorage.setItem('@swiggy_address', '{bad');
      await api.resolveSwiggyDeliveryAddress(22.3, 73.1);
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});
