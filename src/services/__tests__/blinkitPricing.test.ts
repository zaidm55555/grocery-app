import AsyncStorage from '@react-native-async-storage/async-storage';
import { priceBlinkitCart, BlinkitPricingDeps, BlinkitPricingInput } from '../blinkitPricing';
import { getItemPlatformLimit, resolvePlatformProduct, parseBlinkitBill } from '../api';
import * as bridge from '../blinkitBridge';
import { product } from './fixtures';

jest.mock('../blinkitBridge', () => ({
  requestViaBlinkitBridge: jest.fn(),
  getBlinkitPageStorage: jest.fn(() => null),
}));
const request = bridge.requestViaBlinkitBridge as jest.Mock;

const deps = (over: Partial<BlinkitPricingDeps> = {}): BlinkitPricingDeps => ({
  getClosestBlinkitAddress: jest.fn().mockResolvedValue({ id: 77, latitude: 22.3, longitude: 73.1, address: 'Home' }),
  fetchWithTimeout: jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
  parseBlinkitBill,
  getItemPlatformLimit,
  resolvePlatformProduct: resolvePlatformProduct as any,
  ...over,
});

const line = { product: product({ id: 'blinkit-100', originalId: '100' }), quantity: 2 };
const input = (): BlinkitPricingInput => ({
  items: [line], platformItems: [line], subtotal: 56, token: 'tok', gpsLat: 22.3, gpsLng: 73.1,
  simulateNoAddress: false, platformItemLimits: {}, platformItemQuantities: {},
});

const billBody = {
  cart_data: {
    bill_details: { total_cost: 56, delivery_charge: 25, payable_amount: 85 },
    additional_charges: [{ charge_id: 3, amount: 4 }],
    items: [{ product_id: 100, quantity: 2, inventory: 5 }],
  },
};

beforeEach(async () => {
  await AsyncStorage.clear();
  request.mockReset();
});

describe('priceBlinkitCart', () => {
  it('PUT-prices the persisted cart first and parses a live bill', async () => {
    await AsyncStorage.setItem('@blinkit_cart_id', '555');
    request.mockResolvedValueOnce({ status: 200, text: JSON.stringify(billBody) });
    const inp = input();
    const r = await priceBlinkitCart(inp, deps());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('https://blinkit.com/v5/carts/555');
    expect(request.mock.calls[0][1]).toBe('PUT');
    expect(JSON.parse(request.mock.calls[0][2]).items).toEqual([{ product_id: '100', quantity: 2 }]);
    expect(r).toMatchObject({ subtotal: 56, deliveryFee: 25, handlingFee: 4, total: 85, liveBill: true, inStockProductIds: ['blinkit-100'] });
    expect(inp.platformItemLimits['blinkit-100']).toBe(5);
  });

  it('falls back to a POST quote and then PUT-prices a cart id it reveals', async () => {
    request
      .mockResolvedValueOnce({ status: 200, text: JSON.stringify({ cart_id: 9, ...billBody }) }) // POST
      .mockResolvedValueOnce({ status: 200, text: JSON.stringify(billBody) }); // PUT /9
    const r = await priceBlinkitCart(input(), deps());
    expect(request.mock.calls[0][1]).toBe('POST');
    expect(request.mock.calls[1][0]).toBe('https://blinkit.com/v5/carts/9');
    expect(r.liveBill).toBe(true);
    expect(await AsyncStorage.getItem('@blinkit_cart_id')).toBe('9');
  });

  it('forgets a stale cart id on 404', async () => {
    await AsyncStorage.setItem('@blinkit_cart_id', '555');
    request.mockResolvedValue({ status: 404, text: '' });
    await priceBlinkitCart(input(), deps());
    expect(await AsyncStorage.getItem('@blinkit_cart_id')).toBeNull();
  });

  it('flags items Blinkit reports as out of stock', async () => {
    await AsyncStorage.setItem('@blinkit_cart_id', '555');
    const body = { cart_data: { bill_details: { total_cost: 0, payable_amount: 30 }, items: [{ product_id: 100, in_stock: false }] } };
    request.mockResolvedValueOnce({ status: 200, text: JSON.stringify(body) });
    const inp = input();
    const r = await priceBlinkitCart(inp, deps());
    expect(r.outOfStockProductIds).toEqual(['blinkit-100']);
    expect(inp.platformItemLimits['blinkit-100']).toBe(0);
  });

  it('uses the direct fetch as a last resort and keeps the estimate when nothing answers', async () => {
    request.mockResolvedValue(null);
    const d = deps();
    const r = await priceBlinkitCart(input(), d);
    expect(d.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ subtotal: 56, total: 56, liveBill: false, deliveryFee: 0 });
  });

  it('parses the direct response when the bridge is unavailable', async () => {
    request.mockResolvedValue(null);
    const d = deps({ fetchWithTimeout: jest.fn().mockResolvedValue({ ok: true, json: async () => billBody }) });
    const r = await priceBlinkitCart(input(), d);
    expect(r).toMatchObject({ total: 85, liveBill: true });
  });

  it('skips the POST quote when simulating no address', async () => {
    request.mockResolvedValue(null);
    const inp = { ...input(), simulateNoAddress: true };
    await priceBlinkitCart(inp, deps());
    expect(request.mock.calls.filter(c => c[1] === 'POST')).toHaveLength(0);
  });

  it('persists the resolved address', async () => {
    request.mockResolvedValue(null);
    await priceBlinkitCart(input(), deps());
    expect(await AsyncStorage.getItem('@blinkit_address_id')).toBe('77');
  });
});
