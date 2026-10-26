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

const deliveryCalls = () => mockInject.mock.calls.filter(([js]) => String(js).includes('__blSetDeliveryContext'));
const message = (type: string) => act(async () => { mockProps.onMessage({ nativeEvent: { data: JSON.stringify({ type }) } }); });
const tick = (ms: number) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });

beforeEach(async () => {
  jest.useFakeTimers();
  mockInject.mockClear();
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
});
