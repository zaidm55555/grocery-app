import React from 'react';
import { act, render } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// The hidden page POSTs three address-select requests to blinkit.com every time
// the delivery context is applied: applying it every 2s got the page challenged
// by Cloudflare. These tests pin "once per page load / per address change".
const mockInject = jest.fn();
let mockProps: any = null;
jest.mock('react-native-webview', () => {
  const React = require('react');
  const WebView = React.forwardRef((props: any, ref: any) => {
    mockProps = props;
    React.useImperativeHandle(ref, () => ({ injectJavaScript: mockInject, reload: jest.fn() }));
    return null;
  });
  WebView.displayName = 'MockWebView';
  return { WebView, default: WebView };
});
jest.mock('../../services/blinkitBridge', () => ({
  registerBlinkitInjector: jest.fn(),
  unregisterBlinkitInjector: jest.fn(),
  handleBlinkitBridgeMessage: jest.fn(),
  takeBlinkitBridgeCookies: jest.fn(() => null),
  registerBlinkitBridgeReload: jest.fn(),
  unregisterBlinkitBridgeReload: jest.fn(),
  recoverBlinkitBridge: jest.fn(),
}));

import BlinkitBridgeWebView from '../BlinkitBridgeWebView';
import { handleBlinkitBridgeMessage } from '../../services/blinkitBridge';

const deliveryCalls = () => mockInject.mock.calls.filter(([js]) => String(js).includes('__blSetDeliveryContext'));
const message = (type: string, extra?: Record<string, any>) =>
  act(async () => { mockProps.onMessage({ nativeEvent: { data: JSON.stringify({ type, ...extra }) } }); });
const tick = (ms: number) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });

beforeEach(async () => {
  jest.useFakeTimers();
  mockInject.mockClear();
  (handleBlinkitBridgeMessage as jest.Mock).mockClear();
  await AsyncStorage.clear();
  await AsyncStorage.setItem('@blinkit_address_id', '42');
  await AsyncStorage.setItem('@blinkit_lat', '22.3');
  await AsyncStorage.setItem('@blinkit_lng', '73.1');
});
afterEach(() => jest.useRealTimers());

describe('BlinkitBridgeWebView delivery context', () => {
  it('does not apply it before the page reports ready', async () => {
    await render(<BlinkitBridgeWebView />);
    await tick(10000);
    expect(deliveryCalls()).toHaveLength(0);
  });

  it('applies it once when ready, however long the page stays open', async () => {
    await render(<BlinkitBridgeWebView />);
    await message('BL_BRIDGE_READY');
    await tick(60000);
    expect(deliveryCalls()).toHaveLength(1);
  });

  it('applies it again after the page reloads', async () => {
    await render(<BlinkitBridgeWebView />);
    await message('BL_BRIDGE_READY');
    await tick(5000);
    await act(() => { mockProps.onLoadStart(); });
    await tick(5000);
    expect(deliveryCalls()).toHaveLength(1); // not ready yet: nothing injected into a half-loaded page
    await message('BL_BRIDGE_READY');
    await tick(5000);
    expect(deliveryCalls()).toHaveLength(2);
  });

  it('applies it again when the address changes', async () => {
    await render(<BlinkitBridgeWebView />);
    await message('BL_BRIDGE_READY');
    await tick(5000);
    await AsyncStorage.setItem('@blinkit_address_id', '43');
    await tick(5000);
    expect(deliveryCalls()).toHaveLength(2);
  });

  it('injects delivery context before notifying bridge ready', async () => {
    const order: string[] = [];
    mockInject.mockImplementation((js: string) => {
      if (String(js).includes('__blSetDeliveryContext')) order.push('inject');
    });
    (handleBlinkitBridgeMessage as jest.Mock).mockImplementation((p: string) => {
      try {
        if (JSON.parse(p)?.type === 'BL_BRIDGE_READY') order.push('ready');
      } catch {}
    });

    await render(<BlinkitBridgeWebView />);
    await message('BL_BRIDGE_READY');
    await act(async () => {});

    expect(order).toEqual(['inject', 'ready']);
  });

  it('does not let BL_ADDR_RESOLVED overwrite an existing saved address', async () => {
    await render(<BlinkitBridgeWebView />);
    await message('BL_ADDR_RESOLVED', { addressId: '999', lat: '12.9716', lng: '77.5946' });
    await tick(0);

    expect(await AsyncStorage.getItem('@blinkit_address_id')).toBe('42');
    expect(await AsyncStorage.getItem('@blinkit_lat')).toBe('22.3');
    expect(await AsyncStorage.getItem('@blinkit_lng')).toBe('73.1');
  });

  it('saves BL_ADDR_RESOLVED only when no @blinkit_address_id is stored', async () => {
    await AsyncStorage.removeItem('@blinkit_address_id');
    await AsyncStorage.removeItem('@blinkit_lat');
    await AsyncStorage.removeItem('@blinkit_lng');

    await render(<BlinkitBridgeWebView />);
    await message('BL_ADDR_RESOLVED', { addressId: '999', lat: '12.9716', lng: '77.5946' });
    await tick(0);

    expect(await AsyncStorage.getItem('@blinkit_address_id')).toBe('999');
    expect(await AsyncStorage.getItem('@blinkit_lat')).toBe('12.9716');
    expect(await AsyncStorage.getItem('@blinkit_lng')).toBe('77.5946');
  });
});
