import AsyncStorage from '@react-native-async-storage/async-storage';

export type Platform = 'blinkit' | 'swiggy';

export interface LocationData {
  latitude: number;
  longitude: number;
  address?: string;
}

const KEYS = {
  TOKEN: (platform: Platform) => `@auth_token:${platform}`,
  LOCATION: '@user_location',
};

export const storage = {
  async saveToken(platform: Platform, token: string): Promise<void> {
    await AsyncStorage.setItem(KEYS.TOKEN(platform), token);
  },

  async getToken(platform: Platform): Promise<string | null> {
    return await AsyncStorage.getItem(KEYS.TOKEN(platform));
  },

  async removeToken(platform: Platform): Promise<void> {
    await AsyncStorage.removeItem(KEYS.TOKEN(platform));
  },

  async saveLocation(location: LocationData): Promise<void> {
    const prevLocRaw = await AsyncStorage.getItem(KEYS.LOCATION);
    if (prevLocRaw) {
      try {
        const prev = JSON.parse(prevLocRaw);
        if (
          Math.abs(prev.latitude - location.latitude) > 0.005 ||
          Math.abs(prev.longitude - location.longitude) > 0.005
        ) {
          const cartData = await AsyncStorage.getItem('@app_cart');
          const cart = cartData ? JSON.parse(cartData) : [];
          if (cart.length > 0) {
            await AsyncStorage.setItem('@cart_location_mismatch', 'true');
          }
        }
      } catch {}
    }
    await AsyncStorage.setItem(KEYS.LOCATION, JSON.stringify(location));
  },

  async getLocation(): Promise<LocationData | null> {
    const data = await AsyncStorage.getItem(KEYS.LOCATION);
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  },

  async clearAll(): Promise<void> {
    await AsyncStorage.clear();
  },

  async saveCart(cart: any[]): Promise<void> {
    await AsyncStorage.setItem('@app_cart', JSON.stringify(cart));
    if (cart.length > 0) {
      const isMismatch = (await AsyncStorage.getItem('@cart_location_mismatch')) === 'true';
      const existingCartLoc = await AsyncStorage.getItem('@cart_location');
      if (!existingCartLoc || !isMismatch) {
        const loc = await storage.getLocation();
        if (loc) {
          await AsyncStorage.setItem('@cart_location', JSON.stringify(loc));
        }
      }
    } else {
      await AsyncStorage.removeItem('@cart_location');
      await AsyncStorage.removeItem('@cart_location_mismatch');
    }
  },

  async getCartLocation(): Promise<LocationData | null> {
    const data = await AsyncStorage.getItem('@cart_location');
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  },

  async getCart(): Promise<any[]> {
    const data = await AsyncStorage.getItem('@app_cart');
    if (!data) return [];
    try {
      return JSON.parse(data);
    } catch {
      return [];
    }
  }
};
