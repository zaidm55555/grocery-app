import AsyncStorage from '@react-native-async-storage/async-storage';
import { createBlinkitShareLink } from '../blinkitExport';
import { storage } from '../storage';
import { api } from '../api';
import * as bridge from '../blinkitBridge';
import { product, calc } from './fixtures';

jest.mock('../blinkitBridge', () => ({
  requestViaBlinkitBridge: jest.fn(),
  getBlinkitPageStorage: jest.fn(() => null),
}));
const request = bridge.requestViaBlinkitBridge as jest.Mock;

const line = (over = {}, quantity = 2) => ({ product: product({ id: 'blinkit-100', originalId: '100', ...over }), quantity });

beforeEach(async () => {
  await AsyncStorage.clear();
  request.mockReset();
  await storage.saveToken('blinkit', 'auth');
  await storage.saveLocation({ latitude: 22.3, longitude: 73.1 });
});

describe('createBlinkitShareLink', () => {
  it('returns null when Blinkit is not linked or location is unknown', async () => {
    await storage.removeToken('blinkit');
    expect(await createBlinkitShareLink([line()])).toBeNull();
    await storage.saveToken('blinkit', 'auth');
    await AsyncStorage.removeItem('@user_location');
    expect(await createBlinkitShareLink([line()])).toBeNull();
  });

  it('posts the basket via the bridge and extracts the share url', async () => {
    request.mockResolvedValue({ status: 200, text: JSON.stringify({ data: { share_url: 'https://blinkit.com/s/abc' } }) });
    const r = await createBlinkitShareLink([line()]);
    expect(r).toMatchObject({ url: 'https://blinkit.com/s/abc', total: 56, missing: [], outOfStock: [], clamped: [] });
    expect(r!.items[0]).toMatchObject({ product_id: '100', quantity: 2 });
    const [url, method, body] = request.mock.calls[0];
    expect(url).toBe('https://blinkit.com/v1/assist/cart/share');
    expect(method).toBe('POST');
    expect(JSON.parse(body)).toMatchObject({ total_items: 2, cart_value: 56 });
  });

  it('skips out-of-stock lines and clamps quantities to stock', async () => {
    request.mockResolvedValue({ status: 200, text: '{"url":"https://blinkit.com/share/1"}' });
    const r = await createBlinkitShareLink([
      line({ id: 'blinkit-1', originalId: '1', title: 'Gone', inStock: false }),
      line({ id: 'blinkit-2', originalId: '2', title: 'Limited', availableStock: 1 }, 3),
      line({ id: 'blinkit-3', originalId: '3', title: 'Billed OOS' }),
    ], [calc('blinkit', { outOfStockProductIds: ['blinkit-3'] })]);
    expect(r!.outOfStock.map(o => o.name)).toEqual(['Gone', 'Billed OOS']);
    expect(r!.clamped).toEqual([{ name: 'Limited', requestedQty: 3, exportedQty: 1 }]);
    expect(r!.items).toHaveLength(1);
  });

  it('returns an empty result when nothing could be exported', async () => {
    const r = await createBlinkitShareLink([line({ inStock: false })]);
    expect(r).toMatchObject({ url: '', items: [], total: 0 });
    expect(request).not.toHaveBeenCalled();
  });

  it('falls back to a direct post when the bridge fails, and tolerates total failure', async () => {
    request.mockResolvedValue(null);
    const spy = jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue({ ok: true, status: 200, text: async () => 'see https://blinkit.com/cart/share/xyz now' } as any);
    expect((await createBlinkitShareLink([line()]))!.url).toBe('https://blinkit.com/cart/share/xyz');
    spy.mockRejectedValue(new Error('net'));
    expect((await createBlinkitShareLink([line()]))!.url).toBe('');
  });

  it('reports lines it cannot resolve as missing', async () => {
    request.mockResolvedValue({ status: 200, text: '{"url":"https://blinkit.com/share/1"}' });
    jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue({ ok: true, json: async () => ({}) } as any);
    const r = await createBlinkitShareLink([line({ originalId: undefined, productId: undefined, id: 'blinkit-x', title: 'Mystery' })]);
    expect(r!.missing.map(m => m.name)).toEqual(['Mystery']);
  });
});
