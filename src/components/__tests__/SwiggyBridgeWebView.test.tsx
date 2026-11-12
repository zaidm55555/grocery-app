import React from 'react';
import { act, render } from '@testing-library/react-native';

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

jest.mock('../../services/swiggyBridge', () => ({
  registerSwiggyInjector: jest.fn(),
  unregisterSwiggyInjector: jest.fn(),
  handleSwiggyBridgeMessage: jest.fn(),
  onSwiggyBridgeStalled: jest.fn(),
}));

const mockSaveToken = jest.fn((..._args: any[]) => Promise.resolve());
const mockGetToken = jest.fn((..._args: any[]) => Promise.resolve(null));
jest.mock('../../services/storage', () => ({
  storage: {
    getToken: (platform: string) => mockGetToken(platform),
    saveToken: (platform: string, token: string) => mockSaveToken(platform, token),
  },
}));

import SwiggyBridgeWebView from '../SwiggyBridgeWebView';
import { getSwiggySetupMode, setSwiggySetupMode } from '../../services/swiggyBridgeUi';

const message = (type: string, extra?: Record<string, any>) =>
  act(async () => {
    await mockProps.onMessage({ nativeEvent: { data: JSON.stringify({ type, ...extra }) } });
  });

const tick = (ms: number) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  jest.useFakeTimers();
  mockInject.mockClear();
  mockSaveToken.mockClear();
  mockGetToken.mockClear();
  setSwiggySetupMode('hidden');
});

afterEach(() => {
  setSwiggySetupMode('hidden');
  jest.useRealTimers();
});

describe('SwiggyBridgeWebView login routing', () => {
  it('navigates directly to /auth when login opens and user is not logged in', async () => {
    await render(<SwiggyBridgeWebView />);
    await act(async () => { setSwiggySetupMode('login'); });

    await message('GO_LOGIN_SNAPSHOT', { v: false, cookies: '', path: '/instamart' });

    expect(mockInject).toHaveBeenCalledWith(
      expect.stringContaining('https://www.swiggy.com/auth')
    );
  });

  it('navigates to /auth if GO_BRIDGE_READY fires on /instamart while unauthenticated in login mode', async () => {
    await render(<SwiggyBridgeWebView />);
    await act(async () => { setSwiggySetupMode('login'); });
    mockInject.mockClear();

    await message('GO_BRIDGE_READY', { cookies: '', path: '/instamart' });

    expect(mockInject).toHaveBeenCalledWith(
      expect.stringContaining('https://www.swiggy.com/auth')
    );
  });

  it('does not redirect away from /auth when GO_BRIDGE_READY fires on /auth', async () => {
    await render(<SwiggyBridgeWebView />);
    await act(async () => { setSwiggySetupMode('login'); });
    mockInject.mockClear();

    await message('GO_BRIDGE_READY', { cookies: '', path: '/auth' });

    expect(mockInject).not.toHaveBeenCalledWith(
      expect.stringContaining('https://www.swiggy.com/auth')
    );
  });

  it('saves token, closes login mode, and returns /auth back to /instamart after login', async () => {
    await render(<SwiggyBridgeWebView />);
    await act(async () => { setSwiggySetupMode('login'); });
    mockInject.mockClear();

    await message('GO_BRIDGE_READY', { cookies: '_is_logged_in=1; _sid=abc', path: '/' });

    expect(mockSaveToken).toHaveBeenCalledWith('swiggy', '_is_logged_in=1; _sid=abc');
    await tick(2000);
    expect(getSwiggySetupMode()).toBe('hidden');
    expect(mockInject).toHaveBeenCalledWith(
      expect.stringContaining('https://www.swiggy.com/instamart')
    );
  });
});
