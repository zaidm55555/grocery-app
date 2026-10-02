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

describe('priceBlinkitCart: cart id discovery', () => {
  const pageStorage = bridge.getBlinkitPageStorage as jest.Mock;
  afterEach(() => pageStorage.mockReturnValue(null));

  it('prefers the cart id from the hidden page localStorage over the stored one', async () => {
    pageStorage.mockReturnValue(JSON.stringify({ id: 321 }));
    await AsyncStorage.setItem('@blinkit_cart_id', '555');
    request.mockResolvedValueOnce({ status: 200, text: JSON.stringify(billBody) });
    await priceBlinkitCart(input(), deps());
    expect(request.mock.calls[0][0]).toBe('https://blinkit.com/v5/carts/321');
  });

  it('accepts alternate id keys in the page cart', async () => {
    pageStorage.mockReturnValue(JSON.stringify({ cart_id: 654 }));
    request.mockResolvedValueOnce({ status: 200, text: JSON.stringify(billBody) });
    await priceBlinkitCart(input(), deps());
    expect(request.mock.calls[0][0]).toContain('/654');
  });

  it('ignores a corrupt page cart and falls back to the stored id', async () => {
    pageStorage.mockReturnValue('{bad');
    await AsyncStorage.setItem('@blinkit_cart_id', '555');
    request.mockResolvedValueOnce({ status: 200, text: JSON.stringify(billBody) });
    await priceBlinkitCart(input(), deps());
    expect(request.mock.calls[0][0]).toContain('/555');
  });

  it('asks the site which cart is active when the POST quote reveals no id', async () => {
    request
      .mockResolvedValueOnce({ status: 200, text: JSON.stringify(billBody) }) // POST, no cart id
      .mockResolvedValueOnce({ status: 200, text: JSON.stringify({ cart_id: 42 }) }) // GET active
      .mockResolvedValueOnce({ status: 200, text: JSON.stringify(billBody) }); // PUT /42
    const r = await priceBlinkitCart(input(), deps());
    expect(request.mock.calls.map(c => c[1])).toEqual(['POST', 'GET', 'PUT']);
    expect(request.mock.calls[2][0]).toContain('/42');
    expect(r.liveBill).toBe(true);
  });

  it('does not re-PUT the same cart id it already tried', async () => {
    await AsyncStorage.setItem('@blinkit_cart_id', '555');
    request
      .mockResolvedValueOnce({ status: 500, text: '' }) // PUT fails
      .mockResolvedValueOnce({ status: 200, text: JSON.stringify({ cart_id: 555, ...billBody }) }); // POST reveals same id
    const r = await priceBlinkitCart(input(), deps());
    expect(request.mock.calls.map(c => c[1])).toEqual(['PUT', 'POST']);
    expect(r.liveBill).toBe(true);
  });

  it('retries the POST quote with backoff on 429', async () => {
    jest.useFakeTimers();
    request
      .mockResolvedValueOnce({ status: 429, text: '' })
      .mockResolvedValueOnce({ status: 200, text: JSON.stringify(billBody) })
      .mockResolvedValue(null);
    const p = priceBlinkitCart(input(), deps());
    await jest.advanceTimersByTimeAsync(2100);
    const r = await p;
    expect(request.mock.calls.filter(c => c[1] === 'POST')).toHaveLength(2);
    expect(r.liveBill).toBe(true);
    jest.useRealTimers();
  });
});

describe('priceBlinkitCart: session identity', () => {
  it('uses the access token and device id from the site cookie jar', async () => {
    await AsyncStorage.setItem('@blinkit_cookies', 'device_id=dev%201; gr_1_accessToken=ab%2Fcd; x=y');
    await AsyncStorage.setItem('@blinkit_cart_id', '555');
    request.mockResolvedValueOnce({ status: 200, text: JSON.stringify(billBody) });
    await priceBlinkitCart(input(), deps());
    expect(request.mock.calls[0][3]).toMatchObject({ access_token: 'ab/cd', auth_key: 'tok' });
  });

  it('sends the direct fallback with cookies and a device id', async () => {
    await AsyncStorage.setItem('@blinkit_cookies', 'device_id=dev1');
    request.mockResolvedValue(null);
    const d = deps();
    await priceBlinkitCart(input(), d);
    const [, opts] = (d.fetchWithTimeout as jest.Mock).mock.calls[0];
    expect(opts.headers).toMatchObject({ device_id: 'dev1', Cookie: 'device_id=dev1', auth_key: 'tok' });
  });

  it('simulate-no-address: no address id, no cookies, no auth in the direct fallback', async () => {
    await AsyncStorage.setItem('@blinkit_cookies', 'device_id=dev1');
    request.mockResolvedValue(null);
    const d = deps();
    await priceBlinkitCart({ ...input(), simulateNoAddress: true }, d);
    const [, opts] = (d.fetchWithTimeout as jest.Mock).mock.calls[0];
    expect(JSON.parse(opts.body).address_id).toBeUndefined();
    expect(opts.headers.auth_key).toBe('');
    expect(opts.headers.Cookie).toBeUndefined();
    expect(opts.headers.device_id).toMatch(/^sim-/);
    expect(d.getClosestBlinkitAddress).not.toHaveBeenCalled();
  });

  it('binds the closest saved address to the cart request', async () => {
    request.mockResolvedValue(null);
    const d = deps();
    await priceBlinkitCart(input(), d);
    expect(JSON.parse((d.fetchWithTimeout as jest.Mock).mock.calls[0][1].body).address_id).toBe(77);
  });

  it('clears the stored address when there is none, and keeps going', async () => {
    await AsyncStorage.setItem('@blinkit_address_id', 'old');
    request.mockResolvedValue(null);
    await priceBlinkitCart(input(), deps({ getClosestBlinkitAddress: jest.fn().mockResolvedValue(null) }));
    expect(await AsyncStorage.getItem('@blinkit_address_id')).toBeNull();
  });

  it('falls back to the last stored address id if the address lookup throws', async () => {
    await AsyncStorage.setItem('@blinkit_address_id', '88');
    request.mockResolvedValue(null);
    const d = deps({ getClosestBlinkitAddress: jest.fn().mockRejectedValue(new Error('x')) });
    await priceBlinkitCart(input(), d);
    expect(JSON.parse((d.fetchWithTimeout as jest.Mock).mock.calls[0][1].body).address_id).toBe(88);
  });
});

describe('priceBlinkitCart: stock interpretation', () => {
  const put = (body: any) => {
    request.mockResolvedValueOnce({ status: 200, text: JSON.stringify(body) });
  };
  beforeEach(() => AsyncStorage.setItem('@blinkit_cart_id', '555'));
  const bill = { total_cost: 56, payable_amount: 85 };
  const twoLines = () => {
    const l2 = { product: product({ id: 'blinkit-200', originalId: '200', title: 'Milk' }), quantity: 1 };
    return { ...input(), items: [line, l2], platformItems: [line, l2] };
  };

  it('marks lines listed in an unavailable array out of stock', async () => {
    put({ cart_data: { bill_details: bill, items: [{ product_id: 100, quantity: 2 }], unavailable_items: [{ product_id: 200 }] } });
    const r = await priceBlinkitCart(twoLines(), deps());
    expect(r.inStockProductIds).toEqual(['blinkit-100']);
    expect(r.outOfStockProductIds).toEqual(['blinkit-200']);
  });

  it('treats a line Blinkit silently dropped (others billed) as out of stock', async () => {
    put({ cart_data: { bill_details: bill, items: [{ product_id: 100, quantity: 2 }] } });
    const r = await priceBlinkitCart(twoLines(), deps());
    expect(r.outOfStockProductIds).toEqual(['blinkit-200']);
  });

  it('reads items nested under shipments', async () => {
    put({ cart_data: { bill_details: bill, shipments: [{ items: [{ product_id: 100, quantity: 2 }] }, { products: [{ product_id: 200, quantity: 1 }] }] } });
    const r = await priceBlinkitCart(twoLines(), deps());
    expect(r.inStockProductIds.sort()).toEqual(['blinkit-100', 'blinkit-200']);
  });

  it.each([
    ['status OUT_OF_STOCK', { status: 'OUT_OF_STOCK' }],
    ['is_available false', { is_available: false }],
    ['out_of_stock true', { out_of_stock: true }],
    ['inventory.stock 0', { inventory: { stock: 0 } }],
    ['stock 0', { stock: 0 }],
  ])('detects out of stock via %s', async (_n, flag) => {
    put({ cart_data: { bill_details: { total_cost: 0, payable_amount: 30 }, items: [{ product_id: 100, ...flag }] } });
    expect((await priceBlinkitCart(input(), deps())).outOfStockProductIds).toEqual(['blinkit-100']);
  });

  it('zeroes the whole bill when every line is unavailable (nothing would be ordered)', async () => {
    put({ cart_data: { bill_details: { total_cost: 0, payable_amount: 30, delivery_charge: 25 }, items: [{ product_id: 100, in_stock: false }] } });
    const r = await priceBlinkitCart(input(), deps());
    expect(r).toMatchObject({ total: 0, subtotal: 0, deliveryFee: 0, handlingFee: 0, tax: 0, liveBill: true });
  });

  it('keeps the bill when at least one line is in stock', async () => {
    put({ cart_data: { bill_details: bill, items: [{ product_id: 100, quantity: 2 }, { product_id: 200, in_stock: false }] } });
    const r = await priceBlinkitCart(twoLines(), deps());
    expect(r.total).toBe(85);
  });

  it('derives the stock limit from the lower of stock and purchase limit', async () => {
    put({ cart_data: { bill_details: bill, items: [{ product_id: 100, quantity: 2, available_units: 9, purchase_limit: 4 }] } });
    const inp = input();
    await priceBlinkitCart(inp, deps());
    expect(inp.platformItemLimits['blinkit-100']).toBe(4);
  });

  it('infers a limit from a partially billed quantity', async () => {
    put({ cart_data: { bill_details: bill, items: [{ product_id: 100, quantity: 1 }] } });
    const inp = input(); // requested 2
    await priceBlinkitCart(inp, deps());
    expect(inp.platformItemLimits['blinkit-100']).toBe(1);
    expect(inp.platformItemQuantities['blinkit-100']).toBe(1);
  });

  it('a variant flagged out of stock in the catalog stays out of stock when the bill has no opinion', async () => {
    put({ cart_data: { bill_details: bill, items: [] } });
    const l = { product: product({ id: 'blinkit-100', originalId: '100', inStock: false }), quantity: 1 };
    const r = await priceBlinkitCart({ ...input(), items: [l], platformItems: [l] }, deps());
    expect(r.outOfStockProductIds).toEqual(['blinkit-100']);
  });

  it('a skipped line (no blinkit variant) is out of this bill', async () => {
    put({ cart_data: { bill_details: bill, items: [{ product_id: 100, quantity: 2 }] } });
    const skipped = { product: product({ id: 'swiggy-5', platform: 'swiggy' }), quantity: 1 };
    const r = await priceBlinkitCart({ ...input(), items: [line, skipped] }, deps());
    expect(r.outOfStockProductIds).toEqual(['swiggy-5']);
    expect(r.inStockProductIds).toEqual(['blinkit-100']);
  });
});
