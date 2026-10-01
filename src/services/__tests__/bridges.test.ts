describe('swiggyBridge', () => {
  let bridge: typeof import('../swiggyBridge');
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    bridge = require('../swiggyBridge');
  });
  afterEach(() => jest.useRealTimers());

  it('resolves null when no page is connected', async () => {
    await expect(bridge.requestViaSwiggyBridge('/x')).resolves.toBeNull();
  });

  it('queues until the page is ready, then flushes and resolves with the response', async () => {
    const injector = jest.fn();
    bridge.registerSwiggyInjector(injector);
    const p = bridge.requestViaSwiggyBridge('https://swiggy.com/api', 'POST', 'body');
    expect(injector).not.toHaveBeenCalled();
    expect(bridge.handleSwiggyBridgeMessage(JSON.stringify({ type: 'GO_BRIDGE_READY' }))).toBe(true);
    expect(injector).toHaveBeenCalledWith(1, 'https://swiggy.com/api', 'POST', 'body');
    expect(bridge.handleSwiggyBridgeMessage(JSON.stringify({ type: 'GO_API_RESPONSE', id: 1, status: 200, text: 'ok' }))).toBe(true);
    await expect(p).resolves.toEqual({ status: 200, text: 'ok' });
  });

  it('dispatches immediately once ready and supports eval responses', async () => {
    const injector = jest.fn();
    bridge.registerSwiggyInjector(injector);
    bridge.notifySwiggyBridgeReady();
    const p = bridge.requestEvalViaSwiggyBridge('1+1');
    expect(injector).toHaveBeenCalledWith(1, '1+1', '__EVAL__', '1+1');
    bridge.handleSwiggyBridgeMessage(JSON.stringify({ type: 'GO_EVAL_RESPONSE', id: 1, text: '2' }));
    await expect(p).resolves.toEqual({ status: 200, text: '2' });
  });

  it('resolves null when the injector throws', async () => {
    bridge.registerSwiggyInjector(() => { throw new Error('boom'); });
    bridge.notifySwiggyBridgeReady();
    await expect(bridge.requestViaSwiggyBridge('/x')).resolves.toBeNull();
  });

  it('times out, and triggers the stall listener after 3 consecutive timeouts', async () => {
    const injector = jest.fn();
    const stalled = jest.fn();
    bridge.registerSwiggyInjector(injector);
    bridge.onSwiggyBridgeStalled(stalled);
    bridge.notifySwiggyBridgeReady();
    for (let i = 0; i < 3; i++) {
      const p = bridge.requestViaSwiggyBridge('/x');
      jest.advanceTimersByTime(8000);
      await expect(p).resolves.toBeNull();
    }
    expect(stalled).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown/invalid messages and unregistering clears state', () => {
    expect(bridge.handleSwiggyBridgeMessage('not json')).toBe(false);
    expect(bridge.handleSwiggyBridgeMessage(JSON.stringify({ type: 'OTHER' }))).toBe(false);
    const inj = jest.fn();
    bridge.registerSwiggyInjector(inj);
    bridge.unregisterSwiggyInjector(inj);
    return expect(bridge.requestViaSwiggyBridge('/x')).resolves.toBeNull();
  });
});

describe('blinkitBridge', () => {
  let bridge: typeof import('../blinkitBridge');
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    bridge = require('../blinkitBridge');
  });
  afterEach(() => jest.useRealTimers());

  it('resolves null when no page is connected', async () => {
    await expect(bridge.requestViaBlinkitBridge('/x', 'GET')).resolves.toBeNull();
  });

  it('queues until ready and relays responses', async () => {
    const injector = jest.fn();
    bridge.registerBlinkitInjector(injector);
    const p = bridge.requestViaBlinkitBridge('https://blinkit.com/v5/carts', 'PUT', '{}', { a: 'b' });
    expect(injector).not.toHaveBeenCalled();
    bridge.handleBlinkitBridgeMessage(JSON.stringify({ type: 'BL_BRIDGE_READY' }));
    expect(injector).toHaveBeenCalledWith(1, 'https://blinkit.com/v5/carts', 'PUT', '{}', '{"a":"b"}');
    bridge.handleBlinkitBridgeMessage(JSON.stringify({ type: 'BL_API_RESPONSE', id: 1, status: 201, text: 'hi' }));
    await expect(p).resolves.toEqual({ status: 201, text: 'hi' });
  });

  it('times out to null after 15s', async () => {
    bridge.registerBlinkitInjector(jest.fn());
    const p = bridge.requestViaBlinkitBridge('/x', 'GET');
    jest.advanceTimersByTime(15000);
    await expect(p).resolves.toBeNull();
  });

  it('stores relayed page localStorage and hands cookies over once', () => {
    expect(bridge.getBlinkitPageStorage('cart')).toBeNull();
    bridge.handleBlinkitBridgeMessage(JSON.stringify({ type: 'BL_LOCALSTORAGE', key: 'cart', value: '{"id":5}' }));
    expect(bridge.getBlinkitPageStorage('cart')).toBe('{"id":5}');
    bridge.notifyBlinkitBridgeCookies('a=b');
    expect(bridge.takeBlinkitBridgeCookies()).toBe('a=b');
    expect(bridge.takeBlinkitBridgeCookies()).toBeNull();
  });

  it('invokes the registered reload callback', () => {
    const reload = jest.fn();
    bridge.registerBlinkitBridgeReload(reload);
    bridge.reloadBlinkitBridge();
    expect(reload).toHaveBeenCalledTimes(1);
    bridge.unregisterBlinkitBridgeReload();
    bridge.reloadBlinkitBridge();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed messages', () => {
    expect(bridge.handleBlinkitBridgeMessage('{')).toBe(false);
    expect(bridge.handleBlinkitBridgeMessage(JSON.stringify({ type: 'X' }))).toBe(false);
  });
});

describe('swiggyBridgeUi', () => {
  it('tracks mode and notifies subscribers only on change', () => {
    jest.resetModules();
    const ui = require('../swiggyBridgeUi') as typeof import('../swiggyBridgeUi');
    const l = jest.fn();
    const unsub = ui.subscribeSwiggySetupMode(l);
    expect(ui.getSwiggySetupMode()).toBe('hidden');
    ui.setSwiggySetupMode('hidden');
    expect(l).not.toHaveBeenCalled();
    ui.setSwiggySetupMode('login');
    expect(ui.getSwiggySetupMode()).toBe('login');
    expect(l).toHaveBeenCalledTimes(1);
    unsub();
    ui.setSwiggySetupMode('address');
    expect(l).toHaveBeenCalledTimes(1);
  });
});
