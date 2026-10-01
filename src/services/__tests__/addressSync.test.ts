jest.mock('../api', () => ({
  api: {
    getClosestBlinkitAddress: jest.fn(),
    resolveSwiggyDeliveryAddress: jest.fn(),
  },
}));

let AsyncStorage: typeof import('@react-native-async-storage/async-storage').default;
let sync: typeof import('../addressSync');
let api: any;
let storage: typeof import('../storage').storage;

beforeEach(async () => {
  jest.resetModules();
  // The sync's 12s safety timeout is never cleared by the app; fake timers keep it from leaking.
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  AsyncStorage = require('@react-native-async-storage/async-storage');
  sync = require('../addressSync');
  api = require('../api').api;
  storage = require('../storage').storage;
  api.getClosestBlinkitAddress.mockReset().mockResolvedValue({ id: 5, display_address: 'Flat 1', latitude: 22.3, longitude: 73.1 });
  api.resolveSwiggyDeliveryAddress.mockReset().mockResolvedValue({ id: 's1' });
  await AsyncStorage.clear();
});

afterEach(() => jest.useRealTimers());

describe('syncDeliveryAddresses', () => {
  it('does nothing platform-wise when logged out, but still completes', async () => {
    await sync.syncDeliveryAddresses(22.3, 73.1);
    expect(api.getClosestBlinkitAddress).not.toHaveBeenCalled();
    expect(api.resolveSwiggyDeliveryAddress).not.toHaveBeenCalled();
    expect(sync.isAddressSyncing()).toBe(false);
  });

  it('stores the closest Blinkit address and queries Swiggy when tokens exist', async () => {
    await storage.saveToken('blinkit', 'b');
    await storage.saveToken('swiggy', 's');
    await sync.syncDeliveryAddresses(22.3, 73.1);
    expect(await AsyncStorage.getItem('@blinkit_address_id')).toBe('5');
    expect(await AsyncStorage.getItem('@blinkit_address_name')).toBe('Flat 1');
    expect(await AsyncStorage.getItem('@blinkit_lat')).toBe('22.3');
    expect(api.resolveSwiggyDeliveryAddress).toHaveBeenCalledWith(22.3, 73.1, false);
  });

  it('clears stored Blinkit address when none is serviceable', async () => {
    await storage.saveToken('blinkit', 'b');
    await AsyncStorage.setItem('@blinkit_address_id', '1');
    api.getClosestBlinkitAddress.mockResolvedValue(null);
    await sync.syncDeliveryAddresses(22.3, 73.1);
    expect(await AsyncStorage.getItem('@blinkit_address_id')).toBeNull();
  });

  it('dedupes calls for nearby coordinates unless forced', async () => {
    await storage.saveToken('blinkit', 'b');
    await sync.syncDeliveryAddresses(22.3, 73.1);
    await sync.syncDeliveryAddresses(22.301, 73.101);
    expect(api.getClosestBlinkitAddress).toHaveBeenCalledTimes(1);
    await sync.syncDeliveryAddresses(22.301, 73.101, true);
    expect(api.getClosestBlinkitAddress).toHaveBeenCalledTimes(2);
    await sync.syncDeliveryAddresses(23, 74);
    expect(api.getClosestBlinkitAddress).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight sync, notifies listeners, and lets callers await it', async () => {
    await storage.saveToken('blinkit', 'b');
    let release!: () => void;
    api.getClosestBlinkitAddress.mockReturnValue(new Promise<null>(r => { release = () => r(null); }));
    const states: boolean[] = [];
    const unsub = sync.subscribeAddressSync(s => states.push(s));
    const p1 = sync.syncDeliveryAddresses(1, 1);
    const p2 = sync.syncDeliveryAddresses(1, 1);
    await new Promise<void>(r => setImmediate(r));
    expect(sync.isAddressSyncing()).toBe(true);
    const waited = sync.waitForAddressSync();
    release();
    await Promise.all([p1, p2, waited]);
    expect(api.getClosestBlinkitAddress).toHaveBeenCalledTimes(1);
    expect(states).toEqual([true, false]);
    unsub();
  });

  it('a forced sync notifies location-reset listeners, and one failing listener does not break others', async () => {
    const good = jest.fn();
    sync.subscribeLocationReset(() => { throw new Error('x'); });
    const unsub = sync.subscribeLocationReset(good);
    await sync.syncDeliveryAddresses(1, 1, true);
    expect(good).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('survives platform API errors', async () => {
    await storage.saveToken('blinkit', 'b');
    api.getClosestBlinkitAddress.mockRejectedValue(new Error('net'));
    await expect(sync.syncDeliveryAddresses(1, 1)).resolves.toBeUndefined();
    expect(sync.isAddressSyncing()).toBe(false);
  });
});
