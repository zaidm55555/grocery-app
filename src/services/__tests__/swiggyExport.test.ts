import AsyncStorage from '@react-native-async-storage/async-storage';
import { exportCartToSwiggy } from '../swiggyExport';
import { storage } from '../storage';
import { api } from '../api';
import { product } from './fixtures';

const line = (over = {}) => ({ product: product({ id: 'swiggy-1', platform: 'swiggy', ...over }), quantity: 1 });

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
});

describe('exportCartToSwiggy', () => {
  it('returns null when Swiggy is not linked or there is no location', async () => {
    expect(await exportCartToSwiggy([line()])).toBeNull();
    await storage.saveToken('swiggy', 't');
    expect(await exportCartToSwiggy([line()])).toBeNull();
  });

  it('throws a clear error when Instamart does not serve the area', async () => {
    await storage.saveToken('swiggy', 't');
    await storage.saveLocation({ latitude: 1, longitude: 2 });
    jest.spyOn(api, 'resolveSwiggyDeliveryAddress').mockResolvedValue(null);
    await expect(exportCartToSwiggy([line()])).rejects.toThrow(/not available in this area/);
  });
});
