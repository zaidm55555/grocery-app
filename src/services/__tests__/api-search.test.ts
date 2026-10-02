import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../api';
import { storage } from '../storage';
import { product } from './fixtures';

const bl = product({ id: 'blinkit-1' });
const sw = product({ id: 'swiggy-1', platform: 'swiggy' });

beforeEach(async () => {
  await AsyncStorage.clear();
  await storage.saveLocation({ latitude: 22.3, longitude: 73.1 });
});

describe('api.search', () => {
  it('returns [] and still reports each platform when neither is linked', async () => {
    const spy = jest.spyOn(api, 'fetchDirectAPI');
    const cb = jest.fn();
    expect(await api.search('salt', cb)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledWith('blinkit', [], undefined);
    expect(cb).toHaveBeenCalledWith('swiggy', [], undefined);
  });

  it('only searches linked platforms and merges their results', async () => {
    await storage.saveToken('blinkit', 'b');
    const spy = jest.spyOn(api, 'fetchDirectAPI').mockResolvedValue([bl]);
    expect(await api.search('salt')).toEqual([bl]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('blinkit');
  });

  it('merges results from both platforms', async () => {
    await storage.saveToken('blinkit', 'b');
    await storage.saveToken('swiggy', 's');
    jest.spyOn(api, 'fetchDirectAPI').mockImplementation(async (p) => (p === 'blinkit' ? [bl] : [sw]));
    const all = await api.search('salt');
    expect(all).toHaveLength(2);
    expect(all.map(p => p.platform).sort()).toEqual(['blinkit', 'swiggy']);
  });

  it('isolates a failing platform: the other still returns, and the error is surfaced to the callback', async () => {
    await storage.saveToken('blinkit', 'b');
    await storage.saveToken('swiggy', 's');
    jest.spyOn(api, 'fetchDirectAPI').mockImplementation(async (p) => {
      if (p === 'swiggy') throw new Error('SWIGGY_UNAVAILABLE: too far');
      return [bl];
    });
    const cb = jest.fn();
    expect(await api.search('salt', cb)).toEqual([bl]);
    expect(cb).toHaveBeenCalledWith('swiggy', [], 'SWIGGY_UNAVAILABLE: too far');
    expect(cb).toHaveBeenCalledWith('blinkit', [bl], undefined);
  });

  it('only warns on unexpected errors, not on expected availability errors', async () => {
    await storage.saveToken('blinkit', 'b');
    const warn = jest.spyOn(console, 'warn');
    const spy = jest.spyOn(api, 'fetchDirectAPI');
    spy.mockRejectedValueOnce(new Error('BLINKIT_UNAVAILABLE: x'));
    await api.search('salt');
    expect(warn).not.toHaveBeenCalled();
    spy.mockRejectedValueOnce(new Error('network down'));
    await api.search('salt');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('api.searchSingle', () => {
  it('returns [] without a token', async () => {
    const spy = jest.spyOn(api, 'fetchDirectAPI');
    expect(await api.searchSingle('blinkit', 'salt')).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns results for a linked platform and swallows errors', async () => {
    await storage.saveToken('swiggy', 's');
    const spy = jest.spyOn(api, 'fetchDirectAPI').mockResolvedValueOnce([sw]);
    expect(await api.searchSingle('swiggy', 'salt')).toEqual([sw]);
    spy.mockRejectedValueOnce(new Error('boom'));
    expect(await api.searchSingle('swiggy', 'salt')).toEqual([]);
  });
});

describe('api.fetchDirectAPI', () => {
  it('returns [] when there is no location', async () => {
    expect(await api.fetchDirectAPI('blinkit', 'salt', 't', null)).toEqual([]);
    expect(await api.fetchDirectAPI('swiggy', 'salt', 't', null)).toEqual([]);
  });

  it('refuses to search Blinkit when the saved address is too far / missing', async () => {
    for (const status of ['too_far', 'no_address']) {
      await AsyncStorage.setItem('@blinkit_address_status', JSON.stringify({ status }));
      await expect(api.fetchDirectAPI('blinkit', 'salt', 't', { latitude: 1, longitude: 2 })).rejects.toThrow(/BLINKIT_UNAVAILABLE/);
    }
  });
});
