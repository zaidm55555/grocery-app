import React from 'react';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import ProfileScreen from '../../app/(tabs)/profile';
import { storage } from '../../services/storage';
import * as Location from 'expo-location';
import * as locationUtils from '../../utils/location';
import * as addressSync from '../../services/addressSync';

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    useRouter: () => ({ push: mockPush }),
    useFocusEffect: (cb: () => void | (() => void)) => { React.useEffect(cb, []); },
  };
});
jest.mock('expo-location', () => ({ requestForegroundPermissionsAsync: jest.fn() }));

beforeEach(async () => {
  await AsyncStorage.clear();
  mockPush.mockReset();
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockReset().mockResolvedValue({ status: 'granted' });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(locationUtils, 'resolveAreaName').mockResolvedValue('Alkapuri, Vadodara');
  jest.spyOn(addressSync, 'syncDeliveryAddresses').mockResolvedValue();
});

const renderProfile = async () => {
  const utils = render(<ProfileScreen />);
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return utils;
};

describe('Profile screen: accounts', () => {
  it('shows both apps as not linked and offers login', async () => {
    const { getAllByText, getByText } = await renderProfile();
    expect(getAllByText('NOT LINKED')).toHaveLength(2);
    expect(getByText('Login to Link Blinkit')).toBeTruthy();
    expect(getByText('Login to Link Swiggy')).toBeTruthy();
  });

  it('shows linked state per app', async () => {
    await storage.saveToken('blinkit', 'b');
    const { getByText, getAllByText } = await renderProfile();
    expect(getAllByText('LOGGED IN')).toHaveLength(1);
    expect(getByText(/Blinkit session is linked/)).toBeTruthy();
    expect(getByText('Login to Link Swiggy')).toBeTruthy();
  });

  it('opens the login webview for the chosen platform', async () => {
    const { getByText } = await renderProfile();
    fireEvent.press(getByText('Login to Link Blinkit'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/webview', params: { platform: 'blinkit' } });
    fireEvent.press(getByText('Login to Link Swiggy'));
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/webview', params: { platform: 'swiggy' } });
  });

  it('asks for confirmation before disconnecting, and only removes the token when confirmed', async () => {
    await storage.saveToken('swiggy', 's');
    const { getByText } = await renderProfile();
    fireEvent.press(getByText('Disconnect Account'));
    const [title, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
    expect(title).toBe('Unlink Account');
    expect(await storage.getToken('swiggy')).toBe('s'); // not yet
    await act(async () => { await buttons.find((b: any) => b.text === 'Disconnect').onPress(); });
    expect(await storage.getToken('swiggy')).toBeNull();
    await waitFor(() => expect(getByText('Login to Link Swiggy')).toBeTruthy());
  });

  it('cancelling the disconnect keeps the session', async () => {
    await storage.saveToken('swiggy', 's');
    const { getByText } = await renderProfile();
    fireEvent.press(getByText('Disconnect Account'));
    const buttons = (Alert.alert as jest.Mock).mock.calls[0][2];
    expect(buttons.find((b: any) => b.text === 'Cancel').onPress).toBeUndefined();
    expect(await storage.getToken('swiggy')).toBe('s');
  });

  it('resets all data after confirmation', async () => {
    await storage.saveToken('blinkit', 'b');
    const { getByText } = await renderProfile();
    fireEvent.press(getByText('Reset App Data'));
    const buttons = (Alert.alert as jest.Mock).mock.calls[0][2];
    await act(async () => { await buttons.find((b: any) => b.text === 'Reset Everything').onPress(); });
    expect(await storage.getToken('blinkit')).toBeNull();
  });
});

describe('Profile screen: location', () => {
  it('shows the empty state without a location', async () => {
    expect((await renderProfile()).getByText('No Location Synced')).toBeTruthy();
  });

  it('shows the saved address and coordinates', async () => {
    await storage.saveLocation({ latitude: 22.3, longitude: 73.1, address: 'Home Sweet Home' });
    const { getByText } = await renderProfile();
    expect(getByText('Home Sweet Home')).toBeTruthy();
    expect(getByText('GPS: 22.30000, 73.10000')).toBeTruthy();
  });

  it('resolves and saves an area name when the saved address is "Manual: …"', async () => {
    await storage.saveLocation({ latitude: 22.3, longitude: 73.1, address: 'Manual: 22.3, 73.1' });
    const { findByText } = await renderProfile();
    expect(await findByText('Alkapuri, Vadodara')).toBeTruthy();
    expect((await storage.getLocation())!.address).toBe('Alkapuri, Vadodara');
  });

  it('does not overwrite with another "Manual:" result', async () => {
    (locationUtils.resolveAreaName as jest.Mock).mockResolvedValue('Manual: x');
    await storage.saveLocation({ latitude: 22.3, longitude: 73.1, address: 'Manual: 22.3, 73.1' });
    await renderProfile();
    expect((await storage.getLocation())!.address).toBe('Manual: 22.3, 73.1');
  });

  it('fetches GPS, saves it, force-syncs addresses and confirms', async () => {
    jest.spyOn(locationUtils, 'getFastLocation').mockResolvedValue({ latitude: 22.5, longitude: 73.2 });
    const reset = jest.spyOn(addressSync, 'notifyLocationReset');
    const { getByText } = await renderProfile();
    await act(async () => { fireEvent.press(getByText('Fetch Current GPS Location')); });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Location & Addresses Synced', expect.stringContaining('Alkapuri')));
    expect(await storage.getLocation()).toMatchObject({ latitude: 22.5, longitude: 73.2, address: 'Alkapuri, Vadodara' });
    expect(addressSync.syncDeliveryAddresses).toHaveBeenCalledWith(22.5, 73.2, true);
    expect(reset).toHaveBeenCalled();
  });

  it('explains when location permission is denied and saves nothing', async () => {
    (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied' });
    const { getByText } = await renderProfile();
    await act(async () => { fireEvent.press(getByText('Fetch Current GPS Location')); });
    expect(Alert.alert).toHaveBeenCalledWith('Permission Denied', expect.any(String));
    expect(await storage.getLocation()).toBeNull();
  });

  it('explains when GPS returns nothing', async () => {
    jest.spyOn(locationUtils, 'getFastLocation').mockResolvedValue(null);
    const { getByText } = await renderProfile();
    await act(async () => { fireEvent.press(getByText('Fetch Current GPS Location')); });
    expect(Alert.alert).toHaveBeenCalledWith('Location Error', expect.stringContaining('Unable to retrieve'));
  });

  it('reports an error when fetching throws, and re-enables the button', async () => {
    jest.spyOn(locationUtils, 'getFastLocation').mockRejectedValue(new Error('boom'));
    const { getByText } = await renderProfile();
    await act(async () => { fireEvent.press(getByText('Fetch Current GPS Location')); });
    expect(Alert.alert).toHaveBeenCalledWith('Location Error', 'Failed to retrieve GPS location.');
    expect(getByText('Fetch Current GPS Location')).toBeTruthy();
  });

  it('reloads accounts when an address sync finishes (not while it is running)', async () => {
    let listener: (syncing: boolean) => void = () => {};
    jest.spyOn(addressSync, 'subscribeAddressSync').mockImplementation((l: any) => { listener = l; return () => {}; });
    const { queryByText, findByText } = await renderProfile();
    await storage.saveToken('blinkit', 'b');
    await act(async () => { listener(true); await new Promise(r => setTimeout(r, 5)); });
    expect(queryByText(/Blinkit session is linked/)).toBeNull();
    await act(async () => { listener(false); });
    expect(await findByText(/Blinkit session is linked/)).toBeTruthy();
  });
});
