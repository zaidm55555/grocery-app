import * as Location from 'expo-location';
import { getFastLocation, resolveAreaName } from '../location';

jest.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  getLastKnownPositionAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  reverseGeocodeAsync: jest.fn(),
}));
const L = Location as jest.Mocked<typeof Location>;
const pos = (lat: number, lng: number, ts = Date.now()) => ({ coords: { latitude: lat, longitude: lng }, timestamp: ts }) as any;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  L.getLastKnownPositionAsync.mockReset().mockResolvedValue(null);
  L.getCurrentPositionAsync.mockReset();
  L.reverseGeocodeAsync.mockReset();
  (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: false });
});

afterEach(() => jest.useRealTimers());

describe('getFastLocation', () => {
  it('returns a fresh cached position without hitting GPS', async () => {
    L.getLastKnownPositionAsync.mockResolvedValue(pos(1, 2));
    expect(await getFastLocation()).toEqual({ latitude: 1, longitude: 2 });
    expect(L.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('queries GPS when the cache is stale', async () => {
    L.getLastKnownPositionAsync.mockResolvedValue(pos(1, 2, Date.now() - 11 * 60 * 1000));
    L.getCurrentPositionAsync.mockResolvedValue(pos(3, 4));
    expect(await getFastLocation()).toEqual({ latitude: 3, longitude: 4 });
  });

  it('falls back to a stale cached position when GPS fails', async () => {
    L.getLastKnownPositionAsync.mockResolvedValue(pos(1, 2, 1));
    L.getCurrentPositionAsync.mockRejectedValue(new Error('denied'));
    expect(await getFastLocation()).toEqual({ latitude: 1, longitude: 2 });
  });

  it('returns null when nothing is available', async () => {
    L.getCurrentPositionAsync.mockRejectedValue(new Error('denied'));
    expect(await getFastLocation()).toBeNull();
  });

  it('gives up on a hung GPS fix after 5s', async () => {
    L.getCurrentPositionAsync.mockReturnValue(new Promise(() => {}));
    const p = getFastLocation();
    await jest.advanceTimersByTimeAsync(5000);
    expect(await p).toBeNull();
  });
});

describe('resolveAreaName', () => {
  it('uses native reverse geocoding and dedupes parts', async () => {
    L.reverseGeocodeAsync.mockResolvedValue([{ name: 'Alkapuri', city: 'Vadodara', region: 'Gujarat' }] as any);
    expect(await resolveAreaName(22.3, 73.1)).toBe('Alkapuri, Vadodara, Gujarat');
    L.reverseGeocodeAsync.mockResolvedValue([{ name: 'Mumbai', city: 'Mumbai', region: 'Mumbai' }] as any);
    expect(await resolveAreaName(1, 1)).toBe('Mumbai');
  });

  it('falls back to Nominatim when native geocoding is empty', async () => {
    L.reverseGeocodeAsync.mockResolvedValue([] as any);
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ address: { suburb: 'Fatehgunj', city: 'Vadodara', state: 'Gujarat' } }) });
    expect(await resolveAreaName(22.3, 73.1)).toBe('Fatehgunj, Vadodara, Gujarat');
  });

  it('falls back to formatted coordinates when offline', async () => {
    L.reverseGeocodeAsync.mockRejectedValue(new Error('x'));
    (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('offline'));
    expect(await resolveAreaName(22.30001, 73.1)).toBe('22.3000, 73.1000');
  });
});
