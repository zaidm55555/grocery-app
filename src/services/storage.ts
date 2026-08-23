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
