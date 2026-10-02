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

  it('retries once on a plain rate limit', async () => {
    jest.useFakeTimers();
    try {
      request
        .mockResolvedValueOnce({ status: 429, text: '{"message":"slow down"}' })
        .mockResolvedValueOnce({ status: 200, text: '{"url":"https://blinkit.com/share/ok"}' });
      const p = createBlinkitShareLink([line()]);
      await jest.advanceTimersByTimeAsync(2000);
      expect((await p)!.url).toBe('https://blinkit.com/share/ok');
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a transient Cloudflare challenge and succeeds once it clears', async () => {
    jest.useFakeTimers();
    try {
      request
        .mockResolvedValueOnce({ status: 429, text: '<html><title>Just a moment...</title></html>' })
        .mockResolvedValueOnce({ status: 200, text: '{"url":"https://blinkit.com/share/ok"}' });
      const p = createBlinkitShareLink([line()]);
      await jest.advanceTimersByTimeAsync(4000);
      expect((await p)!.url).toBe('https://blinkit.com/share/ok');
    } finally {
      jest.useRealTimers();
    }
  });

  it('gives up after two retries on a persistent challenge and reports why', async () => {
    jest.useFakeTimers();
    const spy = jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue({ ok: false, status: 400, text: async () => '' } as any);
    try {
      request.mockResolvedValue({ status: 429, text: '<html><title>Just a moment...</title>Enable JavaScript and cookies to continue</html>' });
      const p = createBlinkitShareLink([line()]);
      await jest.advanceTimersByTimeAsync(10000);
      const r = await p;
      expect(r!.url).toBe('');
      expect(r!.diag).toEqual({ bridgeStatus: 429, directStatus: 400, challenged: true });
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
      spy.mockRestore();
    }
  });

  it('reports lines it cannot resolve as missing', async () => {
    request.mockResolvedValue({ status: 200, text: '{"url":"https://blinkit.com/share/1"}' });
    jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue({ ok: true, json: async () => ({}) } as any);
    const r = await createBlinkitShareLink([line({ originalId: undefined, productId: undefined, id: 'blinkit-x', title: 'Mystery' })]);
    expect(r!.missing.map(m => m.name)).toEqual(['Mystery']);
  });

  describe('live search fallback for lines without a stored Blinkit id', () => {
    const noId = (over = {}, quantity = 3) => line({ originalId: undefined, productId: undefined, id: 'blinkit-x', title: 'Tata Salt', quantity: '1 kg', ...over }, quantity);
    const found = (over: any = {}) => ({
      ok: true,
      json: async () => ({ layout: [{ data: { name: { text: 'Tata Salt' }, price: '₹28', mrp: '₹30', unit: '1 kg', id: 777, ...over } }] }),
    }) as any;
    beforeEach(() => request.mockResolvedValue({ status: 200, text: '{"url":"https://blinkit.com/share/1"}' }));

    it('resolves the id by search and exports it', async () => {
      jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue(found());
      const r = await createBlinkitShareLink([noId()]);
      expect(r!.items[0]).toMatchObject({ product_id: '777', quantity: 3 });
      expect(r!.missing).toEqual([]);
    });

    it('treats a search hit with zero stock as out of stock', async () => {
      jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue(found({ inventory: 0 }));
      jest.spyOn(require('../api'), 'parseBlinkitProducts').mockReturnValue([{ name: 'Tata Salt', unit: '1 kg', productId: '777', availableStock: 0 }]);
      const r = await createBlinkitShareLink([noId()]);
      expect(r!.outOfStock.map(o => o.name)).toEqual(['Tata Salt']);
      expect(r!.items).toEqual([]);
    });

    it('clamps to the stock reported by search', async () => {
      jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue(found());
      jest.spyOn(require('../api'), 'parseBlinkitProducts').mockReturnValue([{ name: 'Tata Salt', unit: '1 kg', productId: '777', availableStock: 5, maxQuantity: 2 }]);
      const r = await createBlinkitShareLink([noId()]);
      expect(r!.items[0].quantity).toBe(2);
      expect(r!.clamped).toEqual([{ name: 'Tata Salt', requestedQty: 3, exportedQty: 2 }]);
    });

    it('uses just the available stock or just the max when only one is reported', async () => {
      const spy = jest.spyOn(api, 'fetchWithTimeout').mockResolvedValue(found());
      const parse = jest.spyOn(require('../api'), 'parseBlinkitProducts');
      parse.mockReturnValue([{ name: 'Tata Salt', unit: '1 kg', productId: '777', availableStock: 1 }]);
      expect((await createBlinkitShareLink([noId()]))!.items[0].quantity).toBe(1);
      parse.mockReturnValue([{ name: 'Tata Salt', unit: '1 kg', productId: '777', maxQuantity: 2 }]);
      expect((await createBlinkitShareLink([noId()]))!.items[0].quantity).toBe(2);
      expect(spy).toHaveBeenCalled();
    });

    it('reports missing when the search request fails or has no match', async () => {
      const spy = jest.spyOn(api, 'fetchWithTimeout');
      spy.mockResolvedValueOnce({ ok: false } as any);
      expect((await createBlinkitShareLink([noId()]))!.missing).toHaveLength(1);
      spy.mockRejectedValueOnce(new Error('offline'));
      expect((await createBlinkitShareLink([noId()]))!.missing).toHaveLength(1);
    });
  });

  describe('share url extraction', () => {
    const urlFor = async (text: string) => {
      request.mockResolvedValue({ status: 200, text });
      return (await createBlinkitShareLink([line()]))!.url;
    };
    it('prefers a blinkit share/cart url over other urls in the json', async () => {
      expect(await urlFor(JSON.stringify({ a: 'https://example.com/x', share_url: 'https://blinkit.com/s/good', logo: 'https://blinkit.com/logo.png' })))
        .toBe('https://blinkit.com/s/good');
    });
    it('falls back to scanning plain text for a blinkit url', async () => {
      expect(await urlFor('see https://other.com/a and https://blinkit.com/share/zz now')).toBe('https://blinkit.com/share/zz');
      expect(await urlFor('only https://blinkit.com/home here')).toBe('https://blinkit.com/home');
    });
    it('returns an empty url when nothing usable is returned', async () => {
      expect(await urlFor('{"ok":true}')).toBe('');
    });
  });
});
