import AsyncStorage from '@react-native-async-storage/async-storage';
import { storage } from '../storage';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('tokens', () => {
  it('saves, reads and removes per-platform tokens independently', async () => {
    await storage.saveToken('blinkit', 'b-token');
    await storage.saveToken('swiggy', 's-token');
    expect(await storage.getToken('blinkit')).toBe('b-token');
    expect(await storage.getToken('swiggy')).toBe('s-token');
    await storage.removeToken('blinkit');
    expect(await storage.getToken('blinkit')).toBeNull();
    expect(await storage.getToken('swiggy')).toBe('s-token');
  });
});

describe('location', () => {
  it('round-trips a location and returns null when absent or corrupt', async () => {
    expect(await storage.getLocation()).toBeNull();
    await storage.saveLocation({ latitude: 22.3, longitude: 73.1, address: 'Vadodara' });
    expect(await storage.getLocation()).toEqual({ latitude: 22.3, longitude: 73.1, address: 'Vadodara' });
    await AsyncStorage.setItem('@user_location', '{bad json');
    expect(await storage.getLocation()).toBeNull();
  });
});

describe('cart', () => {
  it('returns [] when empty or corrupt', async () => {
    expect(await storage.getCart()).toEqual([]);
    await AsyncStorage.setItem('@app_cart', 'nope');
    expect(await storage.getCart()).toEqual([]);
  });

  it('round-trips the cart and snapshots the location it was built at', async () => {
    await storage.saveLocation({ latitude: 22.3, longitude: 73.1 });
    await storage.saveCart([{ id: 1 }]);
    expect(await storage.getCart()).toEqual([{ id: 1 }]);
    expect(await storage.getCartLocation()).toEqual({ latitude: 22.3, longitude: 73.1 });
  });

  it('clears cart location and mismatch flag when the cart is emptied', async () => {
    await storage.saveLocation({ latitude: 22.3, longitude: 73.1 });
    await storage.saveCart([{ id: 1 }]);
    await AsyncStorage.setItem('@cart_location_mismatch', 'true');
    await storage.saveCart([]);
    expect(await storage.getCartLocation()).toBeNull();
    expect(await AsyncStorage.getItem('@cart_location_mismatch')).toBeNull();
  });

  it('flags a mismatch when the user moves far while the cart is non-empty', async () => {
    await storage.saveLocation({ latitude: 22.3, longitude: 73.1 });
    await storage.saveCart([{ id: 1 }]);
    await storage.saveLocation({ latitude: 22.4, longitude: 73.1 });
    expect(await AsyncStorage.getItem('@cart_location_mismatch')).toBe('true');
    // Cart location is kept at the original spot while mismatched.
    await storage.saveCart([{ id: 1 }, { id: 2 }]);
    expect(await storage.getCartLocation()).toEqual({ latitude: 22.3, longitude: 73.1 });
  });

  it('does not flag a mismatch for small moves or an empty cart', async () => {
    await storage.saveLocation({ latitude: 22.3, longitude: 73.1 });
    await storage.saveLocation({ latitude: 22.302, longitude: 73.1 });
    expect(await AsyncStorage.getItem('@cart_location_mismatch')).toBeNull();
    await storage.saveLocation({ latitude: 23, longitude: 73.1 });
    expect(await AsyncStorage.getItem('@cart_location_mismatch')).toBeNull();
  });
});

describe('clearAll', () => {
  it('wipes everything', async () => {
    await storage.saveToken('blinkit', 'x');
    await storage.clearAll();
    expect(await storage.getToken('blinkit')).toBeNull();
  });
});
