import React from 'react';
import { Alert, TouchableOpacity, Text, TextInput } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, fireEvent, waitFor, act, within } from '@testing-library/react-native';
import SearchScreen from '../../app/(tabs)/index';
import { storage } from '../../services/storage';
import { api, UnifiedProduct } from '../../services/api';
import * as locationUtils from '../../utils/location';
import { product } from '../../services/__tests__/fixtures';

const mockPush = jest.fn();
const mockNavigate = jest.fn();
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    useRouter: () => ({ push: mockPush, navigate: mockNavigate }),
    useFocusEffect: (cb: () => void | (() => void)) => { React.useEffect(cb, []); },
  };
});

jest.mock('../../services/addressSync', () => {
  let syncing = false;
  const syncL = new Set<any>();
  const resetL = new Set<any>();
  return {
    isAddressSyncing: () => syncing,
    waitForAddressSync: jest.fn(async () => { syncing = false; syncL.forEach((l: any) => l(false)); }),
    subscribeAddressSync: (l: any) => { syncL.add(l); return () => { syncL.delete(l); }; },
    subscribeLocationReset: (l: any) => { resetL.add(l); return () => { resetL.delete(l); }; },
    syncDeliveryAddresses: jest.fn().mockResolvedValue(undefined),
    __setSyncing: (v: any) => { syncing = v; },
    __emitSync: (v: any) => { syncing = v; syncL.forEach((l: any) => l(v)); },
    __emitReset: () => resetL.forEach((l: any) => l()),
  };
});
jest.mock('../../services/blinkitBridge', () => {
  let up = true;
  const ls = new Set<any>();
  return {
    isBlinkitBridgeConnected: () => up,
    subscribeBlinkitBridgeStatus: (l: any) => { ls.add(l); return () => { ls.delete(l); }; },
    __setUp: (v: any) => { up = v; ls.forEach((l: any) => l()); },
  };
});
const sync: any = require('../../services/addressSync');
const bridgeMock: any = require('../../services/blinkitBridge');

const DIRECT_NOTE = /Blinkit bridge isn’t connected/;
const LOC = { latitude: 22.3, longitude: 73.1, address: 'Alkapuri, Vadodara' };

const bl = (id: string, title: string, over: Partial<UnifiedProduct> = {}) =>
  product({ id: `blinkit-${id}`, title, price: 40, platform: 'blinkit', quantity: '1 kg', ...over });
const sw = (id: string, title: string, over: Partial<UnifiedProduct> = {}) =>
  product({ id: `swiggy-${id}`, title, price: 42, platform: 'swiggy', quantity: '1 kg', ...over });

let searchImpl: (q: string, cb?: any) => Promise<UnifiedProduct[]>;
const respondWith = (b: UnifiedProduct[], s: UnifiedProduct[], errs: { blinkit?: string; swiggy?: string } = {}) => {
  searchImpl = async (_q, cb) => {
    cb?.('blinkit', b, errs.blinkit);
    cb?.('swiggy', s, errs.swiggy);
    return [...b, ...s];
  };
};

beforeEach(async () => {
  // The platform switcher positions its menu from measureInWindow; the jest View mock never calls back.
  (require('react-native').View.prototype as any).measureInWindow = (cb: any) => cb(20, 120, 220, 40);
  await AsyncStorage.clear();
  mockPush.mockReset();
  mockNavigate.mockReset();
  sync.__setSyncing(false);
  sync.waitForAddressSync.mockClear();
  sync.syncDeliveryAddresses.mockClear();
  bridgeMock.__setUp(true);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(locationUtils, 'resolveAreaName').mockResolvedValue('Resolved Area');
  respondWith([bl('1', 'Tata Salt Blinkit')], [sw('1', 'Aashirvaad Atta Swiggy')]);
  jest.spyOn(api, 'search').mockImplementation((q: string, cb?: any) => searchImpl(q, cb));
  jest.spyOn(api, 'searchSingle').mockResolvedValue([]);
});

const linkBoth = async () => { await storage.saveToken('blinkit', 'b'); await storage.saveToken('swiggy', 's'); };
const renderSearch = async () => {
  const utils = render(<SearchScreen />);
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return utils;
};
// Touchables that share a parent View with the Text showing `label` (e.g. a stepper's − / +).
const touchablesBesideText = (u: any, label: string) => {
  const inst = u.UNSAFE_getAllByType(Text).find((n: any) => String(n.props.children) === label && n.parent.findAllByType(TouchableOpacity).length >= 2);
  return inst.parent.findAllByType(TouchableOpacity);
};
// A filter-menu option: the menu lives in a Modal rendered after the cards, so it is the last match.
const menuOption = (u: any, label: string) => { const all = u.getAllByText(label); return all[all.length - 1]; };
const doSearch = async (utils: any, text = 'salt') => {
  fireEvent.changeText(utils.getByPlaceholderText(/Search Milk/), text);
  await act(async () => { fireEvent.press(utils.getByText('Search')); });
};

describe('Search screen: header and location', () => {
  it('shows the saved address and navigates to profile on tap', async () => {
    await storage.saveLocation(LOC);
    const { getByText } = await renderSearch();
    fireEvent.press(getByText('Alkapuri, Vadodara'));
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/profile');
  });

  it('prompts to configure GPS when there is no location', async () => {
    const { getByText } = await renderSearch();
    expect(getByText('GPS location not set • Tap to configure')).toBeTruthy();
  });

  it('resolves an area name when the saved address is a "Manual:" placeholder', async () => {
    await storage.saveLocation({ ...LOC, address: 'Manual: 22.3, 73.1' });
    const { findByText } = await renderSearch();
    expect(await findByText('Resolved Area')).toBeTruthy();
    expect((await storage.getLocation())!.address).toBe('Resolved Area');
  });

  it('kicks off a background address sync for the saved location', async () => {
    await storage.saveLocation(LOC);
    await renderSearch();
    expect(sync.syncDeliveryAddresses).toHaveBeenCalledWith(22.3, 73.1, false);
  });

  it('shows the basket count badge and opens the basket', async () => {
    await storage.saveLocation(LOC);
    await storage.saveCart([{ product: bl('9', 'In Cart'), quantity: 2 }, { product: bl('8', 'Also'), quantity: 1 }]);
    const { getByText } = await renderSearch();
    expect(getByText('2')).toBeTruthy();
    fireEvent.press(getByText('Basket'));
    expect(mockNavigate).toHaveBeenCalledWith('/(tabs)/cart');
  });
});

describe('Search screen: empty states', () => {
  it('asks to log in when no app is linked', async () => {
    await storage.saveLocation(LOC);
    const { getByText } = await renderSearch();
    expect(getByText('Not Logged In')).toBeTruthy();
    fireEvent.press(getByText('Go to Profile / Login'));
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/profile');
  });

  it('asks for GPS when linked but there is no location', async () => {
    await linkBoth();
    const { getByText } = await renderSearch();
    expect(getByText('GPS Location Required')).toBeTruthy();
  });

  it('shows the default prompt when linked with a location and no query', async () => {
    await linkBoth();
    await storage.saveLocation(LOC);
    expect((await renderSearch()).getByText('Build your optimized basket')).toBeTruthy();
  });

  it('shows "no live results" when a search returns nothing', async () => {
    await linkBoth();
    await storage.saveLocation(LOC);
    respondWith([], []);
    const u = await renderSearch();
    await doSearch(u, 'zzzz');
    expect(await u.findByText('No Live Results Found')).toBeTruthy();
  });

  it('explains when both apps cannot serve the location', async () => {
    await linkBoth();
    await storage.saveLocation(LOC);
    respondWith([], [], { blinkit: 'BLINKIT_UNAVAILABLE: no', swiggy: 'SWIGGY_UNAVAILABLE: no' });
    const u = await renderSearch();
    await doSearch(u);
    expect(await u.findByText('Cannot Search on Current Location')).toBeTruthy();
    expect(u.getByText('Cannot search on your current location for Blinkit or Instamart.')).toBeTruthy();
  });

  it('explains the single linked app that cannot serve the location', async () => {
    await storage.saveToken('swiggy', 's');
    await storage.saveLocation(LOC);
    respondWith([], [], { swiggy: 'SWIGGY_UNAVAILABLE: no' });
    const u = await renderSearch();
    await doSearch(u);
    expect(await u.findByText('Cannot search on your current location for Instamart.')).toBeTruthy();
  });
});

describe('Search screen: searching', () => {
  beforeEach(async () => { await linkBoth(); await storage.saveLocation(LOC); });

  it('searches both apps and shows results from each', async () => {
    const u = await renderSearch();
    await doSearch(u);
    expect(await u.findByText('Tata Salt Blinkit')).toBeTruthy();
    expect(u.getByText('Aashirvaad Atta Swiggy')).toBeTruthy();
    expect(api.search).toHaveBeenCalledWith('salt', expect.any(Function));
    expect(u.getByText('Live Results for “salt”')).toBeTruthy();
  });

  it('submits from the keyboard too', async () => {
    const u = await renderSearch();
    const input = u.getByPlaceholderText(/Search Milk/);
    fireEvent.changeText(input, 'milk');
    await act(async () => { fireEvent(input, 'submitEditing'); });
    expect(api.search).toHaveBeenCalledWith('milk', expect.any(Function));
  });

  it('ignores a blank query', async () => {
    const u = await renderSearch();
    await doSearch(u, '   ');
    expect(api.search).not.toHaveBeenCalled();
  });

  it('does not search without a location', async () => {
    await AsyncStorage.removeItem('@user_location');
    const u = await renderSearch();
    await doSearch(u);
    expect(api.search).not.toHaveBeenCalled();
  });

  it('streams results per app and shows a pending indicator for the slower one', async () => {
    let release!: () => void;
    searchImpl = async (_q, cb) => {
      cb?.('blinkit', [bl('1', 'Fast Blinkit Item')]);
      await new Promise<void>(r => { release = r; });
      cb?.('swiggy', [sw('1', 'Slow Swiggy Item')]);
      return [];
    };
    const u = await renderSearch();
    await doSearch(u);
    expect(await u.findByText('Fast Blinkit Item')).toBeTruthy();
    expect(u.getAllByText(/Searching Instamart…|Fetching Instamart prices…/).length).toBeGreaterThan(0);
    expect(u.queryByText('Slow Swiggy Item')).toBeNull();
    await act(async () => { release(); });
    expect(await u.findByText('Slow Swiggy Item')).toBeTruthy();
  });

  it('shows a per-app location warning while still showing the other app\'s results', async () => {
    respondWith([bl('1', 'Tata Salt Blinkit')], [], { swiggy: 'SWIGGY_UNAVAILABLE: Cannot search Instamart on your current location.' });
    const u = await renderSearch();
    await doSearch(u);
    expect(await u.findByText('Tata Salt Blinkit')).toBeTruthy();
    expect(u.getByText('Instamart — Location')).toBeTruthy();
    expect(u.getByText('Showing Blinkit results only • Cannot search Instamart on current location')).toBeTruthy();
  });

  it('shows the Instamart-only hint when Blinkit cannot serve the location', async () => {
    respondWith([], [sw('1', 'Aashirvaad Atta Swiggy')], { blinkit: 'BLINKIT_UNAVAILABLE: no' });
    const u = await renderSearch();
    await doSearch(u);
    expect(await u.findByText('Showing Instamart results only • Cannot search Blinkit on current location')).toBeTruthy();
  });

  it('survives api.search throwing', async () => {
    (api.search as jest.Mock).mockRejectedValue(new Error('boom'));
    const u = await renderSearch();
    await doSearch(u);
    expect(await u.findByText('No Live Results Found')).toBeTruthy();
  });

  it('quick-search chips run a search', async () => {
    const u = await renderSearch();
    const chips = u.getAllByText(/^(Milk|Bread|Eggs|Butter|Cheese)$/);
    await act(async () => { fireEvent.press(chips[0]); });
    expect(api.search).toHaveBeenCalledWith(expect.any(String), expect.any(Function));
  });

  it('clearing the box removes results and shows the quick chips again', async () => {
    const u = await renderSearch();
    await doSearch(u);
    await u.findByText('Tata Salt Blinkit');
    expect(u.queryByText('Quick:')).toBeNull();
    // the × button is the only touchable inside the search box besides the input
    const box = u.UNSAFE_getByType(TextInput).parent!;
    await act(async () => { fireEvent.press(box.findAllByType(TouchableOpacity)[0]); });
    expect(u.getByPlaceholderText(/Search Milk/).props.value).toBe('');
    await waitFor(() => expect(u.queryByText('Tata Salt Blinkit')).toBeNull());
    expect(u.getByText('Quick:')).toBeTruthy();
  });
});

describe('Search screen: address sync gating', () => {
  beforeEach(async () => { await linkBoth(); await storage.saveLocation(LOC); });

  it('waits for an in-progress address sync before searching', async () => {
    sync.__setSyncing(true);
    const u = await renderSearch();
    fireEvent.changeText(u.getByPlaceholderText(/Search Milk/), 'salt');
    await act(async () => { fireEvent.press(u.getByText('Syncing…')); });
    expect(sync.waitForAddressSync).toHaveBeenCalled();
    expect(api.search).toHaveBeenCalled();
  });

  it('shows the syncing banner while syncing and hides it when done', async () => {
    const u = await renderSearch();
    await act(async () => { sync.__emitSync(true); });
    expect(u.getByText('Syncing store delivery addresses for your location…')).toBeTruthy();
    expect(u.getByText('Syncing…')).toBeTruthy();
    await act(async () => { sync.__emitSync(false); });
    expect(u.queryByText('Syncing store delivery addresses for your location…')).toBeNull();
  });

  it('resets the search when the location is reset elsewhere', async () => {
    const u = await renderSearch();
    await doSearch(u);
    await u.findByText('Tata Salt Blinkit');
    await act(async () => { sync.__emitReset(); });
    await waitFor(() => expect(u.queryByText('Tata Salt Blinkit')).toBeNull());
    expect(u.getByPlaceholderText(/Search Milk/).props.value).toBe('');
  });
});

describe('Search screen: Blinkit direct-fetch note', () => {
  beforeEach(async () => { await linkBoth(); await storage.saveLocation(LOC); });

  it('is shown with results when Blinkit is linked but the bridge is down', async () => {
    bridgeMock.__setUp(false);
    const u = await renderSearch();
    await doSearch(u);
    expect(await u.findByText(DIRECT_NOTE)).toBeTruthy();
  });

  it('is hidden when the bridge is connected', async () => {
    const u = await renderSearch();
    await doSearch(u);
    await u.findByText('Tata Salt Blinkit');
    expect(u.queryByText(DIRECT_NOTE)).toBeNull();
  });

  it('appears and disappears live as the bridge disconnects/connects', async () => {
    const u = await renderSearch();
    await doSearch(u);
    await u.findByText('Tata Salt Blinkit');
    await act(async () => { bridgeMock.__setUp(false); });
    expect(u.getByText(DIRECT_NOTE)).toBeTruthy();
    await act(async () => { bridgeMock.__setUp(true); });
    expect(u.queryByText(DIRECT_NOTE)).toBeNull();
  });

  it('is hidden when Blinkit is not linked', async () => {
    await storage.removeToken('blinkit');
    bridgeMock.__setUp(false);
    const u = await renderSearch();
    await doSearch(u);
    await u.findByText('Aashirvaad Atta Swiggy');
    expect(u.queryByText(DIRECT_NOTE)).toBeNull();
  });

  it('is hidden when filtered to Instamart only', async () => {
    bridgeMock.__setUp(false);
    const u = await renderSearch();
    await doSearch(u);
    await u.findByText(DIRECT_NOTE);
    fireEvent.press(u.getByText('All Stores'));
    fireEvent.press(menuOption(u, 'Instamart'));
    await waitFor(() => expect(u.queryByText(DIRECT_NOTE)).toBeNull());
  });
});

describe('Search screen: store filter', () => {
  beforeEach(async () => { await linkBoth(); await storage.saveLocation(LOC); });

  it('filters results to the chosen app and back', async () => {
    const u = await renderSearch();
    await doSearch(u);
    await u.findByText('Tata Salt Blinkit');
    fireEvent.press(u.getByText('All Stores'));
    fireEvent.press(menuOption(u, 'Blinkit'));
    await waitFor(() => expect(u.queryByText('Aashirvaad Atta Swiggy')).toBeNull());
    expect(u.getByText('Tata Salt Blinkit')).toBeTruthy();
    fireEvent.press(u.getByText('Showing results from')); // reopen the switcher via its pill
    fireEvent.press(menuOption(u, 'All Stores'));
    expect(await u.findByText('Aashirvaad Atta Swiggy')).toBeTruthy();
  });

  it('explains an unlinked app when filtered to it with no results', async () => {
    await storage.removeToken('swiggy');
    const u = await renderSearch();
    fireEvent.press(u.getByText('All Stores'));
    fireEvent.press(menuOption(u, 'Instamart'));
    expect(await u.findByText('Not Logged into Instamart')).toBeTruthy();
    fireEvent.press(u.getByText('Login to Instamart'));
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/profile');
  });
});

describe('Search screen: adding to the basket', () => {
  beforeEach(async () => { await linkBoth(); await storage.saveLocation(LOC); });

  const addButtonFor = (u: any, title: string) => {
    const card = u.getByText(title).parent!.parent!; // name Text → card
    const touchables = within(card).UNSAFE_getAllByType(TouchableOpacity);
    return touchables[touchables.length - 1];
  };

  it('adds a new line to the saved basket', async () => {
    const u = await renderSearch();
    await doSearch(u);
    await u.findByText('Tata Salt Blinkit');
    await act(async () => { fireEvent.press(addButtonFor(u, 'Tata Salt Blinkit')); });
    await waitFor(async () => expect((await storage.getCart()).length).toBe(1));
    expect((await storage.getCart())[0]).toMatchObject({ quantity: 1, product: { id: 'blinkit-1' } });
  });

  it('refuses to add an out-of-stock listing', async () => {
    respondWith([bl('1', 'Gone Item', { inStock: false })], []);
    const u = await renderSearch();
    await doSearch(u);
    await u.findByText('Gone Item');
    await act(async () => { fireEvent.press(addButtonFor(u, 'Gone Item')); });
    expect(Alert.alert).toHaveBeenCalledWith('Out of Stock', expect.stringContaining('Blinkit'));
    expect(await storage.getCart()).toEqual([]);
  });

  it('refuses to add a listing with zero stock', async () => {
    respondWith([bl('1', 'Zero Stock', { availableStock: 0 })], []);
    const u = await renderSearch();
    await doSearch(u);
    await u.findByText('Zero Stock');
    await act(async () => { fireEvent.press(addButtonFor(u, 'Zero Stock')); });
    expect(Alert.alert).toHaveBeenCalledWith('Out of Stock', expect.any(String));
  });

  it('shows a stepper for a line already in the basket and changes its quantity', async () => {
    await storage.saveCart([{ product: bl('1', 'Tata Salt Blinkit'), quantity: 2 }]);
    const u = await renderSearch();
    await doSearch(u);
    await u.findByText('Tata Salt Blinkit');
    expect(u.getByText('2')).toBeTruthy();
    const steppers = touchablesBesideText(u, '2');
    await act(async () => { fireEvent.press(steppers[1]); }); // +
    await waitFor(async () => expect((await storage.getCart())[0].quantity).toBe(3));
    await act(async () => { fireEvent.press(touchablesBesideText(u, '3')[0]); }); // −
    await waitFor(async () => expect((await storage.getCart())[0].quantity).toBe(2));
  });

  it('removes the line when stepping down from one', async () => {
    await storage.saveCart([{ product: bl('1', 'Tata Salt Blinkit'), quantity: 1 }]);
    const u = await renderSearch();
    await doSearch(u);
    await u.findByText('Tata Salt Blinkit');
    await act(async () => { fireEvent.press(touchablesBesideText(u, '1')[0]); });
    await waitFor(async () => expect(await storage.getCart()).toEqual([]));
  });

  it('blocks stepping past the stock limit with an alert', async () => {
    const limited = bl('1', 'Tata Salt Blinkit', { availableStock: 2 });
    await storage.saveCart([{ product: limited, quantity: 2 }]);
    respondWith([limited], []);
    const u = await renderSearch();
    await doSearch(u);
    await u.findByText('Tata Salt Blinkit');
    await act(async () => { fireEvent.press(touchablesBesideText(u, '2')[1]); });
    expect(Alert.alert).toHaveBeenCalledWith('Stock Limit Reached', 'Only 2 units available on Blinkit.');
    expect((await storage.getCart())[0].quantity).toBe(2);
  });

  it('opens the size picker for a card with several listings and adds the chosen one', async () => {
    respondWith([bl('1', 'Tata Salt 1kg', { quantity: '1 kg' }), bl('2', 'Tata Salt 1kg', { quantity: '1 kg', price: 38, id: 'blinkit-2' })], []);
    const u = await renderSearch();
    await doSearch(u);
    await u.findByText('2 options');
    fireEvent.press(u.getByText('2 options'));
    expect(await u.findByText(/Blinkit · 2 sizes/)).toBeTruthy();
  });
});

describe('Search screen: auto-match on the other app', () => {
  beforeEach(async () => { await linkBoth(); await storage.saveLocation(LOC); });
  const addFirst = async (u: any) => {
    await u.findByText('Tata Salt Blinkit');
    const card = u.getByText('Tata Salt Blinkit').parent!.parent!;
    const touchables = within(card).UNSAFE_getAllByType(TouchableOpacity);
    await act(async () => { fireEvent.press(touchables[touchables.length - 1]); });
  };
  const swiggyCandidate = sw('9', 'Tata Salt Blinkit Pack', { quantity: '1 kg', price: 41 });

  it('searches the other app after adding, then applies the match on Confirm and shows a toast', async () => {
    respondWith([bl('1', 'Tata Salt Blinkit')], []);
    (api.searchSingle as jest.Mock).mockResolvedValue([swiggyCandidate]);
    const u = await renderSearch();
    await doSearch(u, 'salt');
    await addFirst(u);
    expect(await u.findByText('Confirm the matches')).toBeTruthy();
    fireEvent.press(await u.findByText(/^Confirm · /));
    await waitFor(async () => expect((await storage.getCart())[0].product.platformPrices?.swiggy?.id).toBe('swiggy-9'));
    expect(await u.findByText(/Added to basket · now on Instamart/)).toBeTruthy();
    expect(api.searchSingle).toHaveBeenCalledWith('swiggy', 'Tata Salt Blinkit');
  });

  it('Skip leaves the line unmatched on the other app', async () => {
    respondWith([bl('1', 'Tata Salt Blinkit')], []);
    (api.searchSingle as jest.Mock).mockResolvedValue([swiggyCandidate]);
    const u = await renderSearch();
    await doSearch(u);
    await addFirst(u);
    fireEvent.press(await u.findByText('Skip'));
    await waitFor(() => expect(u.queryByText('Confirm the matches')).toBeNull());
    expect((await storage.getCart())[0].product.platformPrices).toBeUndefined();
  });

  it('"None of these match — skip this app" is honoured on Confirm', async () => {
    respondWith([bl('1', 'Tata Salt Blinkit')], []);
    (api.searchSingle as jest.Mock).mockResolvedValue([swiggyCandidate]);
    const u = await renderSearch();
    await doSearch(u);
    await addFirst(u);
    fireEvent.press(await u.findByText(/Other matches/));
    fireEvent.press(await u.findByText(/None of these match/));
    expect(await u.findByText('Confirm · 0 matches')).toBeTruthy();
    fireEvent.press(u.getByText('Skip'));
    expect((await storage.getCart())[0].product.platformPrices).toBeUndefined();
  });

  it('does not open the match flow when the other app is not linked', async () => {
    await storage.removeToken('swiggy');
    respondWith([bl('1', 'Tata Salt Blinkit')], []);
    const u = await renderSearch();
    await doSearch(u);
    await addFirst(u);
    await new Promise(r => setTimeout(r, 20));
    expect(u.queryByText('Matching on other apps…')).toBeNull();
    expect(api.searchSingle).not.toHaveBeenCalled();
  });

  it('shows "no close match" and lets the user pick manually when nothing similar is found', async () => {
    respondWith([bl('1', 'Tata Salt Blinkit')], []);
    (api.searchSingle as jest.Mock).mockResolvedValue([sw('7', 'Completely Different Thing', { quantity: '5 L', price: 999 })]);
    const u = await renderSearch();
    await doSearch(u);
    await addFirst(u);
    expect(await u.findByText('no close match')).toBeTruthy();
  });

  it('reports a search error and can retry', async () => {
    respondWith([bl('1', 'Tata Salt Blinkit')], []);
    (api.searchSingle as jest.Mock).mockRejectedValueOnce(new Error('net down')).mockResolvedValue([swiggyCandidate]);
    const u = await renderSearch();
    await doSearch(u);
    await addFirst(u);
    expect(await u.findByText('error')).toBeTruthy();
    await act(async () => { fireEvent.press(u.getAllByText('Retry')[0]); });
    expect(await u.findByText('auto-matched')).toBeTruthy();
  });

  it('does not re-run matching for a line that already has the other app', async () => {
    const matched = { ...bl('1', 'Tata Salt Blinkit'), platformPrices: { swiggy: { id: 'swiggy-9', title: 'Tata Salt Blinkit Pack', brand: '', quantity: '1 kg', price: 41, imageUrl: '' } } } as any;
    await storage.saveCart([{ product: matched, quantity: 1 }]);
    respondWith([bl('1', 'Tata Salt Blinkit')], []);
    const u = await renderSearch();
    await doSearch(u);
    await u.findByText('Tata Salt Blinkit');
    expect(api.searchSingle).not.toHaveBeenCalled();
  });
});
