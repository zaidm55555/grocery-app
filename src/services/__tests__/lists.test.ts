import AsyncStorage from '@react-native-async-storage/async-storage';
import { lists, mergeLines } from '../lists';
import { storage } from '../storage';
import { product } from './fixtures';

const line = (id: string, quantity = 1) => ({ product: product({ id }), quantity });

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('mergeLines', () => {
  it('sums quantities for matching ids and appends new lines without mutating inputs', () => {
    const base = [line('a', 1)];
    const merged = mergeLines(base, [line('a', 2), line('b', 1)]);
    expect(merged.map(l => [l.product.id, l.quantity])).toEqual([['a', 3], ['b', 1]]);
    expect(base[0].quantity).toBe(1);
  });
});

describe('saved lists', () => {
  it('saves a snapshot detached from the live cart and skips empty input', async () => {
    const items = [line('a', 2), line('zero', 0)];
    const saved = await lists.save('  Weekly ', items);
    expect(saved?.name).toBe('Weekly');
    expect(saved?.items).toHaveLength(1);
    items[0].quantity = 99;
    expect((await lists.getAll())[0].items[0].quantity).toBe(2);

    expect(await lists.save('   ', items)).toBeNull();
    expect(await lists.save('Empty', [line('z', 0)])).toBeNull();
  });

  it('overwrites a list with the same name case-insensitively', async () => {
    await lists.save('Weekly', [line('a')]);
    await lists.save('weekly', [line('b', 3)]);
    const all = await lists.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].items[0].product.id).toBe('b');
  });

  it('orders by most recently updated and removes by id', async () => {
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1000);
    const first = await lists.save('One', [line('a')]);
    now.mockReturnValue(2000);
    await lists.save('Two', [line('b')]);
    expect((await lists.getAll()).map(l => l.name)).toEqual(['Two', 'One']);
    await lists.remove(first!.id);
    expect((await lists.getAll()).map(l => l.name)).toEqual(['Two']);
  });

  it('survives corrupt storage', async () => {
    await AsyncStorage.setItem('@saved_lists', 'garbage');
    expect(await lists.getAll()).toEqual([]);
    await AsyncStorage.setItem('@saved_lists', '{"not":"array"}');
    expect(await lists.getAll()).toEqual([]);
  });
});

describe('recent orders', () => {
  it('records newest first, caps at 5, and ignores empty orders', async () => {
    await lists.recordOrder([line('x', 0)], 'blinkit');
    expect(await lists.getRecent()).toEqual([]);
    for (let i = 0; i < 7; i++) await lists.recordOrder([line(`p${i}`)], i % 2 ? 'swiggy' : 'blinkit');
    const recent = await lists.getRecent();
    expect(recent).toHaveLength(5);
    expect(recent[0].items[0].product.id).toBe('p6');
    expect(recent[0].platform).toBe('blinkit');
  });
});

describe('cart operations', () => {
  it('addToCart merges into the persisted cart', async () => {
    await storage.saveCart([line('a', 1)]);
    const next = await lists.addToCart([line('a', 2), line('b', 1)]);
    expect(next.map(l => l.quantity)).toEqual([3, 1]);
    expect(await storage.getCart()).toHaveLength(2);
  });

  it('replaceCart overwrites the cart with a clean snapshot', async () => {
    await storage.saveCart([line('a', 5)]);
    const next = await lists.replaceCart([line('b', 2), line('c', 0)]);
    expect(next).toHaveLength(1);
    expect((await storage.getCart())[0].product.id).toBe('b');
  });
});
