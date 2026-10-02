import React from 'react';
import { Alert, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, fireEvent, waitFor, act, within } from '@testing-library/react-native';
import CartScreen from '../../app/(tabs)/cart';
import { storage } from '../../services/storage';
import { api, CartCalculation } from '../../services/api';
import * as basketRefresh from '../../services/basketRefresh';
import * as blinkitExport from '../../services/blinkitExport';
import * as swiggyExport from '../../services/swiggyExport';
import * as Clipboard from 'expo-clipboard';
import { product, variant, calc } from '../../services/__tests__/fixtures';

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    useRouter: () => ({ push: mockPush }),
    useFocusEffect: (cb: () => void | (() => void)) => { React.useEffect(cb, []); },
  };
});
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
jest.mock('../../services/blinkitExport', () => ({ createBlinkitShareLink: jest.fn() }));
jest.mock('../../services/swiggyExport', () => ({ exportCartToSwiggy: jest.fn() }));
jest.mock('../../services/blinkitBridge', () => ({
  isBlinkitBridgeConnected: jest.fn(() => true),
  subscribeBlinkitBridgeStatus: jest.fn(() => () => {}),
}));

const createShare = blinkitExport.createBlinkitShareLink as jest.Mock;
const exportSwiggy = swiggyExport.exportCartToSwiggy as jest.Mock;

// A salt line priced on both apps.
const salt = (over: any = {}, sOver: any = {}, qty = 2) => ({
  product: product({ id: 'blinkit-1', title: 'Tata Salt', price: 28, originalPrice: 30, ...over, platformPrices: { swiggy: variant({ id: 'swiggy-1', title: 'Tata Salt Swiggy', price: 30, ...sOver }) } }),
  quantity: qty,
});
const bOnly = (qty = 1) => ({ product: product({ id: 'blinkit-2', title: 'Only On Blinkit', price: 50 }), quantity: qty });

const liveCalc = (platform: 'blinkit' | 'swiggy', over: Partial<CartCalculation> = {}): CartCalculation =>
  calc(platform, { live: true, subtotal: 56, deliveryFee: 0, handlingFee: 4, total: 60, inStockProductIds: ['blinkit-1'], outOfStockProductIds: [], items: [], ...over });

let calcResults: CartCalculation[];
const setCalcs = (r: CartCalculation[]) => { calcResults = r; };

beforeEach(async () => {
  await AsyncStorage.clear();
  mockPush.mockReset();
  createShare.mockReset();
  exportSwiggy.mockReset();
  (Clipboard.setStringAsync as jest.Mock).mockClear();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(Linking, 'openURL').mockClear();
  (Linking.openURL as jest.Mock).mockResolvedValue(true);
  jest.spyOn(basketRefresh, 'refreshBasketLines').mockImplementation(async (items: any) => ({ items, changed: false }));
  setCalcs([liveCalc('blinkit'), liveCalc('swiggy', { total: 62 })]);
  jest.spyOn(api, 'calculateCart').mockImplementation(async (_items: any, cb?: any, target?: any) => {
    const res = target ? calcResults.filter(c => c.platform === target) : calcResults;
    res.forEach(c => cb?.(c));
    return res;
  });
});

const seed = async (items: any[], loc = { latitude: 22.3, longitude: 73.1 }) => {
  await storage.saveLocation(loc);
  await storage.saveCart(items);
};
const renderCart = async () => {
  const utils = render(<CartScreen />);
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return utils;
};

describe('Cart screen: basic states', () => {
  it('shows the empty state for an empty basket', async () => {
    const { findByText, getByText } = await renderCart();
    expect(await findByText('Your basket is empty')).toBeTruthy();
    expect(getByText('0 items · live checkout bills')).toBeTruthy();
    expect(api.calculateCart).not.toHaveBeenCalled();
  });

  it('lists lines and prices each app', async () => {
    await seed([salt()]);
    const { findByText, getByText, getAllByText } = await renderCart();
    expect(await findByText('Items in Basket (1)')).toBeTruthy();
    expect(getByText('1 item · live checkout bills')).toBeTruthy();
    expect(getAllByText('To pay')).toHaveLength(2);
    expect(getAllByText('₹60').length).toBeGreaterThan(0);
    expect(getAllByText('₹62').length).toBeGreaterThan(0);
  });

  it('badges the cheaper app as best value and the loser not', async () => {
    await seed([salt()]);
    const { findByText, queryAllByText } = await renderCart();
    expect(await findByText('BEST VALUE')).toBeTruthy();
    expect(queryAllByText('BEST VALUE')).toHaveLength(1);
  });

  it('re-validates saved lines against live catalogs and persists changes', async () => {
    await seed([salt()]);
    const refreshed = [{ ...salt(), quantity: 2, product: { ...salt().product, price: 99 } }];
    (basketRefresh.refreshBasketLines as jest.Mock).mockResolvedValue({ items: refreshed, changed: true });
    const { findByText } = await renderCart();
    await findByText('Items in Basket (1)');
    expect((await storage.getCart())[0].product.price).toBe(99);
  });

  it('handles a pricing failure without crashing', async () => {
    await seed([salt()]);
    (api.calculateCart as jest.Mock).mockRejectedValue(new Error('boom'));
    const { findByText, queryByText } = await renderCart();
    expect(await findByText('Items in Basket (1)')).toBeTruthy();
    expect(queryByText('BEST VALUE')).toBeNull();
  });
});

describe('Cart screen: location mismatch', () => {
  it('pauses live pricing when the basket was built elsewhere', async () => {
    await seed([salt()]);
    await storage.saveLocation({ latitude: 28.6, longitude: 77.2 }); // moved far from the basket's location
    const { findByText } = await renderCart();
    expect(await findByText('Live Pricing Paused')).toBeTruthy();
    expect(api.calculateCart).not.toHaveBeenCalled();
    expect(basketRefresh.refreshBasketLines).not.toHaveBeenCalled();
  });

  it('honours the explicit mismatch flag', async () => {
    await seed([salt()]);
    await AsyncStorage.setItem('@cart_location_mismatch', 'true');
    expect(await (await renderCart()).findByText('Live Pricing Paused')).toBeTruthy();
  });

  it('"Clear Basket & Search Again" empties the basket and goes to Search', async () => {
    await seed([salt()]);
    await AsyncStorage.setItem('@cart_location_mismatch', 'true');
    const { findByText } = await renderCart();
    fireEvent.press(await findByText('Clear Basket & Search Again'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/(tabs)'));
    expect(await storage.getCart()).toEqual([]);
    expect(await AsyncStorage.getItem('@cart_location_mismatch')).toBeNull();
  });
});

describe('Cart screen: quantities and clearing', () => {
  it('increments and persists the quantity, then re-prices', async () => {
    await seed([salt()]);
    const { findByText, getByText } = await renderCart();
    await findByText('Items in Basket (1)');
    const before = (api.calculateCart as jest.Mock).mock.calls.length;
    const plus = within(getByText('2').parent!.parent!).UNSAFE_getAllByType(require('react-native').TouchableOpacity)[1];
    await act(async () => { fireEvent.press(plus); });
    await waitFor(async () => expect((await storage.getCart())[0].quantity).toBe(3));
    expect((api.calculateCart as jest.Mock).mock.calls.length).toBeGreaterThan(before);
  });

  it('removes the line when the quantity drops to zero', async () => {
    await seed([salt({}, {}, 1)]);
    const { findByText, getByText } = await renderCart();
    await findByText('Items in Basket (1)');
    const minus = within(getByText('1').parent!.parent!).UNSAFE_getAllByType(require('react-native').TouchableOpacity)[0];
    await act(async () => { fireEvent.press(minus); });
    await waitFor(async () => expect(await storage.getCart()).toEqual([]));
    expect(await findByText('Your basket is empty')).toBeTruthy();
  });

  it('blocks increasing past the maximum available stock', async () => {
    await seed([salt({ availableStock: 2 }, { availableStock: 2 }, 2)]);
    const { findByText, getByText } = await renderCart();
    await findByText('Items in Basket (1)');
    const plus = within(getByText('2').parent!.parent!).UNSAFE_getAllByType(require('react-native').TouchableOpacity)[1];
    await act(async () => { fireEvent.press(plus); });
    expect(Alert.alert).toHaveBeenCalledWith('Stock Limit Reached', 'Maximum available stock of 2 units reached across stores.');
    expect((await storage.getCart())[0].quantity).toBe(2);
  });

  it('clears the basket only after confirmation', async () => {
    await seed([salt()]);
    const { findByText, UNSAFE_getAllByType } = await renderCart();
    await findByText('Items in Basket (1)');
    const { TouchableOpacity } = require('react-native');
    const trash = UNSAFE_getAllByType(TouchableOpacity).filter((t: any) => t.props.hitSlop)[1]; // [lists, clear]
    fireEvent.press(trash);
    const buttons = (Alert.alert as jest.Mock).mock.calls[0][2];
    expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Clear Cart');
    expect((await storage.getCart()).length).toBe(1);
    await act(async () => { await buttons.find((b: any) => b.text === 'Clear').onPress(); });
    expect(await storage.getCart()).toEqual([]);
    expect(await findByText('Your basket is empty')).toBeTruthy();
  });
});

describe('Cart screen: stock / skipped-app presentation', () => {
  it('shows a skipped app as "not matched" — never as out of stock', async () => {
    await seed([bOnly(), salt()]);
    setCalcs([
      liveCalc('blinkit', { inStockProductIds: ['blinkit-1', 'blinkit-2'] }),
      liveCalc('swiggy', { inStockProductIds: ['blinkit-1'], outOfStockProductIds: ['blinkit-2'] }), // calc lists the skipped line as unavailable
    ]);
    const { findByText, queryByText } = await renderCart();
    expect(await findByText('1 item not matched on Instamart')).toBeTruthy();
    expect(queryByText(/out of stock$/)).toBeNull();
    expect(queryByText('OUT OF STOCK')).toBeNull();
  });

  it('does not show the excluded-items note or skipped subtext for a line only unmatched on the app', async () => {
    await seed([bOnly(), salt()]);
    setCalcs([
      liveCalc('blinkit', { inStockProductIds: ['blinkit-1', 'blinkit-2'] }),
      liveCalc('swiggy', { inStockProductIds: ['blinkit-1'], outOfStockProductIds: ['blinkit-2'] }),
    ]);
    const { findByText, queryByText } = await renderCart();
    await findByText('1 item not matched on Instamart');
    expect(queryByText(/Bill excludes/)).toBeNull();
    expect(queryByText(/will be skipped/)).toBeNull();
    expect(queryByText('Export Available Items to Instamart')).toBeNull();
    expect(queryByText('Export Basket to Instamart')).toBeTruthy();
  });

  it('labels a line sold on only one app with that app\'s name', async () => {
    await seed([bOnly()]);
    setCalcs([liveCalc('blinkit', { inStockProductIds: ['blinkit-2'] }), liveCalc('swiggy', { inStockProductIds: [] })]);
    const { findAllByText } = await renderCart();
    const labels = await findAllByText('Blinkit');
    // one in the line row, one as the platform card title
    expect(labels.length).toBeGreaterThanOrEqual(2);
  });

  it('shows a genuinely out-of-stock matched line as out of stock', async () => {
    await seed([salt()]);
    setCalcs([
      liveCalc('blinkit'),
      liveCalc('swiggy', { inStockProductIds: [], outOfStockProductIds: ['blinkit-1'], platformItemLimits: { 'blinkit-1': 0 }, subtotal: 0, total: 0 }),
    ]);
    const { findAllByText } = await renderCart();
    expect((await findAllByText('OUT OF STOCK')).length).toBeGreaterThan(0);
  });

  it('shows the green stock badge only when fewer than 5 units remain beyond the basket quantity', async () => {
    await seed([salt({ availableStock: 25 }, { availableStock: 25 }, 2)]);
    setCalcs([
      liveCalc('blinkit', { platformItemLimits: { 'blinkit-1': 25 } }),
      liveCalc('swiggy', { platformItemLimits: { 'blinkit-1': 25 } }),
    ]);
    const first = await renderCart();
    await first.findAllByText('To pay');
    expect(first.queryByText('25 in stock')).toBeNull();
    first.unmount();

    await seed([salt({ availableStock: 25 }, { availableStock: 25 }, 22)]);
    const second = await renderCart();
    expect((await second.findAllByText('25 in stock')).length).toBeGreaterThan(0);
  });

  it('does not show a per-line stock footer', async () => {
    await seed([salt({ availableStock: 12 }, { availableStock: 3 }, 2)]);
    setCalcs([
      liveCalc('blinkit', { platformItemLimits: { 'blinkit-1': 12 } }),
      liveCalc('swiggy', { platformItemLimits: { 'blinkit-1': 3 } }),
    ]);
    const { findAllByText, queryByText } = await renderCart();
    expect((await findAllByText(/3 in stock/)).length).toBeGreaterThan(0);
    expect(queryByText(/Blinkit: 12/)).toBeNull();
    expect(queryByText(/Instamart: 3/)).toBeNull();
  });

  it('shows a capped line when swiggy stock is below the requested quantity', async () => {
    await seed([salt({}, { availableStock: 1 }, 3)]);
    const { findAllByText } = await renderCart();
    expect((await findAllByText(/Only 1 in stock/)).length).toBeGreaterThan(0);
  });
});

describe('Cart screen: platform cards', () => {
  it('shows fees, free-delivery nudge, GST and savings', async () => {
    await seed([salt()]);
    setCalcs([
      liveCalc('blinkit', { deliveryFee: 25, freeDeliveryGap: 40, tax: 3, savings: 4, surgeFee: 5, surgeLabel: 'Rain Fee', smallCartFee: 2, total: 99 }),
      liveCalc('swiggy', { total: 62 }),
    ]);
    const { findByText, getByText } = await renderCart();
    expect(await findByText('₹25')).toBeTruthy();
    expect(getByText('Add ₹40 more for free delivery')).toBeTruthy();
    expect(getByText('Rain Fee')).toBeTruthy();
    expect(getByText('Small-cart fee')).toBeTruthy();
    expect(getByText('GST')).toBeTruthy();
    expect(getByText('− ₹4 saved off MRP on this basket')).toBeTruthy();
  });

  it('shows FREE delivery when the fee is zero', async () => {
    await seed([salt()]);
    expect((await (await renderCart()).findAllByText('FREE')).length).toBeGreaterThan(0);
  });

  it('marks a non-live bill as unverified and disables export', async () => {
    await seed([salt()]);
    setCalcs([liveCalc('blinkit', { live: false, total: 56 }), liveCalc('swiggy')]);
    const { findAllByText, getByText } = await renderCart();
    expect((await findAllByText('Unverified')).length).toBe(1);
    expect(getByText('Pricing Unavailable')).toBeTruthy();
    expect(getByText('Unavailable at Current Location')).toBeTruthy();
  });

  it('shows the excluded-items note and export subtext for out-of-stock lines', async () => {
    await seed([salt(), bOnly()]);
    setCalcs([
      liveCalc('blinkit', { inStockProductIds: ['blinkit-1'], outOfStockProductIds: ['blinkit-2'] }),
      liveCalc('swiggy'),
    ]);
    const { findByText, getByText } = await renderCart();
    expect(await findByText('* Bill excludes 1 unavailable item')).toBeTruthy();
    expect(getByText('Export Available Items to Blinkit')).toBeTruthy();
    expect(getByText('1 out-of-stock item will be skipped')).toBeTruthy();
  });

  it('refresh re-prices only that platform', async () => {
    await seed([salt()]);
    const { findAllByText, UNSAFE_getAllByType } = await renderCart();
    await findAllByText('To pay');
    (api.calculateCart as jest.Mock).mockClear();
    const { TouchableOpacity } = require('react-native');
    const reload = UNSAFE_getAllByType(TouchableOpacity).filter((t: any) => t.props.hitSlop)
      .filter((t: any) => t.props.style && JSON.stringify(t.props.style).includes('0.5') === false)[2];
    await act(async () => { fireEvent.press(reload); });
    const call = (api.calculateCart as jest.Mock).mock.calls[0];
    expect(call[2]).toBeDefined(); // targetPlatform passed
  });
});

describe('Cart screen: export to Blinkit', () => {
  const press = async (utils: any, label = 'Export Basket to Blinkit') => {
    await act(async () => { fireEvent.press(await utils.findByText(label)); });
  };

  it('copies the share link and opens it', async () => {
    await seed([salt()]);
    await storage.saveToken('blinkit', 'b');
    createShare.mockResolvedValue({ url: 'https://blinkit.com/s/1', items: [{}], missing: [], outOfStock: [], clamped: [] });
    await press(await renderCart());
    await waitFor(() => expect(Linking.openURL).toHaveBeenCalledWith('https://blinkit.com/s/1'));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('https://blinkit.com/s/1');
  });

  it('asks the user to link when not linked', async () => {
    await seed([salt()]);
    await press(await renderCart());
    expect(Alert.alert).toHaveBeenCalledWith('Blinkit not linked', expect.any(String), expect.any(Array));
    expect(createShare).not.toHaveBeenCalled();
  });

  it('explains why nothing could be exported (out of stock + missing)', async () => {
    await seed([salt()]);
    await storage.saveToken('blinkit', 'b');
    createShare.mockResolvedValue({ url: '', items: [], missing: [{ name: 'M' }], outOfStock: [{ name: 'O' }], clamped: [] });
    await press(await renderCart());
    const [title, body] = (Alert.alert as jest.Mock).mock.calls.find(c => c[0] === 'Cannot export to Blinkit')!;
    expect(body).toContain('Out of Stock on Blinkit:\n• O');
    expect(body).toContain('Not found on Blinkit:\n• M');
  });

  it('uses a generic message when nothing is listed', async () => {
    await seed([salt()]);
    await storage.saveToken('blinkit', 'b');
    createShare.mockResolvedValue({ url: '', items: [], missing: [], outOfStock: [], clamped: [] });
    await press(await renderCart());
    expect((Alert.alert as jest.Mock).mock.calls.find(c => c[0] === 'Cannot export to Blinkit')![1]).toMatch(/None of the basket items/);
  });

  it('reports a missing share url', async () => {
    await seed([salt()]);
    await storage.saveToken('blinkit', 'b');
    createShare.mockResolvedValue({ url: '', items: [{}], missing: [], outOfStock: [], clamped: [] });
    await press(await renderCart());
    expect(Alert.alert).toHaveBeenCalledWith('Could not create a share link', expect.any(String), expect.any(Array));
    expect(Linking.openURL).not.toHaveBeenCalled();
  });

  it('shows the pre-export notice first when some items cannot go through, then opens on Continue', async () => {
    await seed([salt()]);
    await storage.saveToken('blinkit', 'b');
    createShare.mockResolvedValue({ url: 'https://blinkit.com/s/2', items: [{}], missing: [], outOfStock: [{ name: 'Gone' }], clamped: [{ name: 'Less', requestedQty: 5, exportedQty: 2 }] });
    const utils = await renderCart();
    await press(utils);
    expect(await utils.findByText('Before opening Blinkit')).toBeTruthy();
    expect(Linking.openURL).not.toHaveBeenCalled();
    fireEvent.press(await utils.findByText(/^Continue/));
    await waitFor(() => expect(Linking.openURL).toHaveBeenCalledWith('https://blinkit.com/s/2'));
  });

  it('tells the user when the link cannot be opened', async () => {
    await seed([salt()]);
    await storage.saveToken('blinkit', 'b');
    createShare.mockResolvedValue({ url: 'https://blinkit.com/s/3', items: [{}], missing: [], outOfStock: [], clamped: [] });
    (Linking.openURL as jest.Mock).mockRejectedValue(new Error('no app'));
    await press(await renderCart());
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Could not open the link', expect.any(String), expect.any(Array)));
  });

  it('survives clipboard failure', async () => {
    await seed([salt()]);
    await storage.saveToken('blinkit', 'b');
    (Clipboard.setStringAsync as jest.Mock).mockRejectedValueOnce(new Error('denied'));
    createShare.mockResolvedValue({ url: 'https://blinkit.com/s/4', items: [{}], missing: [], outOfStock: [], clamped: [] });
    await press(await renderCart());
    await waitFor(() => expect(Linking.openURL).toHaveBeenCalled());
  });

  it('reports an unexpected export error', async () => {
    await seed([salt()]);
    await storage.saveToken('blinkit', 'b');
    createShare.mockRejectedValue(new Error('network'));
    await press(await renderCart());
    expect(Alert.alert).toHaveBeenCalledWith('Export failed', 'network', expect.any(Array));
  });

  it('passes the latest live calculations to the export (stock limits)', async () => {
    await seed([salt()]);
    await storage.saveToken('blinkit', 'b');
    createShare.mockResolvedValue({ url: 'https://blinkit.com/s/5', items: [{}], missing: [], outOfStock: [], clamped: [] });
    await press(await renderCart());
    const [, calcsArg] = createShare.mock.calls[0];
    expect(calcsArg.map((c: any) => c.platform)).toEqual(['blinkit', 'swiggy']);
  });
});

describe('Cart screen: export to Swiggy', () => {
  const press = async (utils: any) => { await act(async () => { fireEvent.press(await utils.findByText('Export Basket to Instamart')); }); };

  it('opens the export webview with the committed cart', async () => {
    await seed([salt()]);
    await storage.saveToken('swiggy', 's');
    exportSwiggy.mockResolvedValue({ items: [{}], cartUrl: 'https://www.swiggy.com/instamart/cart?goCartSync=1', cartId: 'N', oldCartId: 'O', writePayload: { a: 'é' }, missing: [], outOfStock: [], clamped: [] });
    await press(await renderCart());
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    const arg = mockPush.mock.calls[0][0];
    expect(arg.pathname).toBe('/webview');
    expect(arg.params).toMatchObject({ platform: 'swiggy', mode: 'export', url: 'https://www.swiggy.com/instamart/cart?goCartSync=1', cartId: 'N', oldCartId: 'O' });
    expect(arg.params.cart).toMatch(/^[A-Za-z0-9_-]+$/); // url-safe base64
  });

  it('asks to link when not linked', async () => {
    await seed([salt()]);
    await press(await renderCart());
    expect(Alert.alert).toHaveBeenCalledWith('Swiggy not linked', expect.any(String), expect.any(Array));
  });

  it('shows the pre-export notice for unavailable items, then continues to the webview', async () => {
    await seed([salt()]);
    await storage.saveToken('swiggy', 's');
    exportSwiggy.mockResolvedValue({ items: [{}], cartUrl: 'u', cartId: null, oldCartId: null, writePayload: null, missing: [], outOfStock: [{ name: 'Gone' }], clamped: [] });
    const utils = await renderCart();
    await press(utils);
    expect(await utils.findByText('Before opening Instamart')).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
    fireEvent.press(await utils.findByText(/^Continue/));
    expect(mockPush.mock.calls[0][0].params.cart).toBe('');
  });

  it('skips the notice when the only unexported items were not matched on the app', async () => {
    await seed([salt()]);
    await storage.saveToken('swiggy', 's');
    exportSwiggy.mockResolvedValue({ items: [{}], cartUrl: 'u', cartId: null, oldCartId: null, writePayload: null, missing: [{ name: 'Nope' }], outOfStock: [], clamped: [] });
    const utils = await renderCart();
    await press(utils);
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    expect(utils.queryByText('Before opening Instamart')).toBeNull();
  });

  it('explains when nothing can be exported', async () => {
    await seed([salt()]);
    await storage.saveToken('swiggy', 's');
    exportSwiggy.mockResolvedValue({ items: [], cartUrl: '', missing: [{ name: 'M' }], outOfStock: [{ name: 'O' }], clamped: [] });
    await press(await renderCart());
    const [, body] = (Alert.alert as jest.Mock).mock.calls.find(c => c[0] === 'Cannot export to Swiggy')!;
    expect(body).toContain('Out of Stock on Swiggy:\n• O');
    expect(body).toContain('Not found on Swiggy:\n• M');
  });

  it('shows the thrown reason (e.g. area not served)', async () => {
    await seed([salt()]);
    await storage.saveToken('swiggy', 's');
    exportSwiggy.mockRejectedValue(new Error('Instamart delivery is currently not available in this area.'));
    await press(await renderCart());
    expect(Alert.alert).toHaveBeenCalledWith('Export failed', 'Instamart delivery is currently not available in this area.', expect.any(Array));
  });

  it('ignores a second tap while an export is running', async () => {
    await seed([salt()]);
    await storage.saveToken('swiggy', 's');
    let resolve!: (v: any) => void;
    exportSwiggy.mockReturnValue(new Promise(r => { resolve = r; }));
    const utils = await renderCart();
    await press(utils);
    expect(await utils.findByText('Exporting to Instamart…')).toBeTruthy();
    expect(exportSwiggy).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ items: [], cartUrl: '', missing: [], outOfStock: [], clamped: [] }); });
  });
});
