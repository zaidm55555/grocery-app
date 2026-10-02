import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, invalidateAddressSessionCache } from '../api';
import { storage } from '../storage';

const json = (body: any, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as any;
const status = async () => JSON.parse((await AsyncStorage.getItem('@blinkit_address_status')) || 'null');

const HERE = { lat: 22.3, lng: 73.1 };
const addr = (id: string, lat: number, lng: number, extra: any = {}) => ({ id, latitude: String(lat), longitude: String(lng), ...extra });

beforeEach(async () => {
  await AsyncStorage.clear();
  invalidateAddressSessionCache();
  await storage.saveToken('blinkit', 'tok');
});

describe('api.fetchWithTimeout', () => {
  it('resolves with the fetch response', async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true });
    await expect(api.fetchWithTimeout('u', {})).resolves.toEqual({ ok: true });
  });

  it('rejects with a timeout when fetch hangs', async () => {
    jest.useFakeTimers();
    (globalThis as any).fetch = jest.fn(() => new Promise(() => {}));
    const p = api.fetchWithTimeout('u', {}, 1000);
    const assertion = expect(p).rejects.toThrow('Network timeout');
    await jest.advanceTimersByTimeAsync(1001);
    await assertion;
    jest.useRealTimers();
  });
});

describe('api.getBlinkitAddresses', () => {
  it('returns [] without a token (no request)', async () => {
    await storage.removeToken('blinkit');
    const spy = jest.spyOn(api, 'fetchWithTimeout');
    expect(await api.getBlinkitAddresses(1, 2)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends the token and coordinates', async () => {
    const spy = jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue(json({ addresses: [{ id: 1 }] }));
    await api.getBlinkitAddresses(22.3, 73.1);
    const [url, opts] = spy.mock.calls[0] as any;
    expect(url).toContain('cur_lat=22.3&cur_lon=73.1');
    expect(opts.headers).toMatchObject({ access_token: 'tok', lat: '22.3', lon: '73.1' });
  });

  it.each([
    ['addresses', { addresses: [{ id: 1 }] }],
    ['data', { data: [{ id: 1 }] }],
    ['addresses_data', { addresses_data: [{ id: 1 }] }],
    ['bare array', [{ id: 1 }]],
    ['nested addresses_data', { data: { addresses_data: [{ id: 1 }] } }],
  ])('parses the %s response shape', async (_n, body) => {
    jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue(json(body));
    expect(await api.getBlinkitAddresses(1, 2)).toEqual([{ id: 1 }]);
  });

  it('returns [] for non-ok responses, junk bodies and network errors', async () => {
    const spy = jest.spyOn(api, 'fetchWithTimeout');
    spy.mockResolvedValueOnce(json({}, false));
    expect(await api.getBlinkitAddresses(1, 2)).toEqual([]);
    spy.mockResolvedValueOnce(json({ data: 'nope' }));
    expect(await api.getBlinkitAddresses(1, 2)).toEqual([]);
    spy.mockRejectedValueOnce(new Error('offline'));
    expect(await api.getBlinkitAddresses(1, 2)).toEqual([]);
  });
});

describe('api.getClosestBlinkitAddress', () => {
  it('picks the closest saved address and records in_range status', async () => {
    const near = addr('near', 22.301, 73.101, { display_address: 'Home' });
    jest.spyOn(api, 'getBlinkitAddresses').mockResolvedValue([addr('far', 22.5, 73.3), near]);
    expect(await api.getClosestBlinkitAddress(HERE.lat, HERE.lng)).toBe(near);
    expect(await status()).toMatchObject({ status: 'in_range', name: 'Home', addressId: 'near' });
  });

  it('accepts lat/lon/lng field variants', async () => {
    const a = { id: 'x', lat: '22.3', lon: '73.1' };
    jest.spyOn(api, 'getBlinkitAddresses').mockResolvedValue([a]);
    expect(await api.getClosestBlinkitAddress(HERE.lat, HERE.lng)).toBe(a);
  });

  it('treats an address beyond 35 km as too_far and returns null', async () => {
    jest.spyOn(api, 'getBlinkitAddresses').mockResolvedValue([addr('far', 23.3, 73.1, { name: 'Office' })]); // ~111 km
    expect(await api.getClosestBlinkitAddress(HERE.lat, HERE.lng)).toBeNull();
    expect(await status()).toMatchObject({ status: 'too_far', name: 'Office' });
  });

  it('records no_address when there are no saved addresses', async () => {
    jest.spyOn(api, 'getBlinkitAddresses').mockResolvedValue([]);
    expect(await api.getClosestBlinkitAddress(HERE.lat, HERE.lng)).toBeNull();
    expect(await status()).toEqual({ status: 'no_address' });
  });

  it('records no_address when none of the addresses have usable coordinates', async () => {
    jest.spyOn(api, 'getBlinkitAddresses').mockResolvedValue([{ id: 'a' }, { id: 'b', latitude: 'x', longitude: 'y' }]);
    expect(await api.getClosestBlinkitAddress(HERE.lat, HERE.lng)).toBeNull();
    expect(await status()).toEqual({ status: 'no_address' });
  });

  it('serves repeat calls nearby from the session cache without a network call', async () => {
    const near = addr('near', 22.3, 73.1);
    const spy = jest.spyOn(api, 'getBlinkitAddresses').mockResolvedValue([near]);
    await api.getClosestBlinkitAddress(HERE.lat, HERE.lng);
    expect(await api.getClosestBlinkitAddress(HERE.lat + 0.001, HERE.lng)).toBe(near);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('session-caches a negative result too (too_far → null, no refetch)', async () => {
    const spy = jest.spyOn(api, 'getBlinkitAddresses').mockResolvedValue([addr('far', 23.3, 73.1)]);
    await api.getClosestBlinkitAddress(HERE.lat, HERE.lng);
    expect(await api.getClosestBlinkitAddress(HERE.lat, HERE.lng)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refetches when the location moved more than 1 km', async () => {
    const spy = jest.spyOn(api, 'getBlinkitAddresses').mockResolvedValue([addr('a', 22.3, 73.1)]);
    await api.getClosestBlinkitAddress(HERE.lat, HERE.lng);
    await api.getClosestBlinkitAddress(HERE.lat + 0.05, HERE.lng);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('force bypasses every cache', async () => {
    const spy = jest.spyOn(api, 'getBlinkitAddresses').mockResolvedValue([addr('a', 22.3, 73.1)]);
    await api.getClosestBlinkitAddress(HERE.lat, HERE.lng);
    await api.getClosestBlinkitAddress(HERE.lat, HERE.lng, true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  describe('persistent cache (fresh app session)', () => {
    const seed = (entry: any) => AsyncStorage.setItem('@blinkit_address_cache', JSON.stringify(entry));

    it('restores an in_range entry and rewrites the status', async () => {
      const a = addr('c1', 22.3, 73.1);
      await seed({ ...HERE, lat: 22.3, lng: 73.1, status: 'in_range', address: a, distanceKm: 0.2, name: 'Home', at: Date.now() });
      const spy = jest.spyOn(api, 'getBlinkitAddresses');
      expect(await api.getClosestBlinkitAddress(22.3, 73.1)).toEqual(a);
      expect(spy).not.toHaveBeenCalled();
      expect(await status()).toMatchObject({ status: 'in_range', addressId: 'c1', name: 'Home' });
    });

    it('restores too_far and no_address entries as null', async () => {
      const spy = jest.spyOn(api, 'getBlinkitAddresses');
      await seed({ lat: 22.3, lng: 73.1, status: 'too_far', address: null, distanceKm: 50, name: 'Far', at: Date.now() });
      expect(await api.getClosestBlinkitAddress(22.3, 73.1)).toBeNull();
      expect(await status()).toMatchObject({ status: 'too_far', name: 'Far' });
      invalidateAddressSessionCache();
      await seed({ lat: 22.3, lng: 73.1, status: 'no_address', address: null, at: Date.now() });
      expect(await api.getClosestBlinkitAddress(22.3, 73.1)).toBeNull();
      expect(await status()).toEqual({ status: 'no_address' });
      expect(spy).not.toHaveBeenCalled();
    });

    it('ignores a stale (>24h) or far-away cache entry and corrupt JSON', async () => {
      const spy = jest.spyOn(api, 'getBlinkitAddresses').mockResolvedValue([]);
      await seed({ lat: 22.3, lng: 73.1, status: 'in_range', address: addr('o', 1, 1), at: Date.now() - 25 * 3600 * 1000 });
      await api.getClosestBlinkitAddress(22.3, 73.1);
      invalidateAddressSessionCache();
      await seed({ lat: 10, lng: 10, status: 'in_range', address: addr('o', 1, 1), at: Date.now() });
      await api.getClosestBlinkitAddress(22.3, 73.1);
      invalidateAddressSessionCache();
      await AsyncStorage.setItem('@blinkit_address_cache', '{bad');
      await api.getClosestBlinkitAddress(22.3, 73.1);
      expect(spy).toHaveBeenCalledTimes(3);
    });
  });
});
