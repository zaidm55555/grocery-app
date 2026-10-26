import { buildAiBasket, searchAllStores, AiModeError, AiProgress, TwinSearch } from '../aiMode';
import { GroqError, GroqJsonRequest } from '../groq';
import { api, UnifiedProduct } from '../api';
import { searchForMatch } from '../matchSearch';
import { MAX_TWIN_SEARCHES } from '../../utils/aiBasket';
import { product } from './fixtures';

jest.mock('../addressSync', () => ({
  isAddressSyncing: jest.fn(() => false),
  waitForAddressSync: jest.fn(async () => {}),
}));
const sync = require('../addressSync') as { isAddressSyncing: jest.Mock; waitForAddressSync: jest.Mock };

// Fake values only.
const PROXY = { url: 'https://ai-proxy.example.workers.dev/chat', token: 'test-app-token-not-real' };
const bl = (id: string, title: string, over: Partial<UnifiedProduct> = {}) =>
  product({ id: `blinkit-${id}`, title, platform: 'blinkit', quantity: '500 ml', price: 30, ...over });
const sw = (id: string, title: string, over: Partial<UnifiedProduct> = {}) =>
  product({ id: `swiggy-${id}`, title, platform: 'swiggy', quantity: '500 ml', price: 31, ...over });

const CATALOG: Record<string, UnifiedProduct[]> = {
  milk: [bl('milk', 'Amul Taaza Toned Milk', { price: 27 }), sw('milk', 'Amul Taaza Toned Milk', { price: 28 })],
  eggs: [bl('eggs', 'Farm Eggs 6 pcs', { quantity: '6 pcs', price: 48 })],
  saffron: [],
};

// Fake LLM: answers the parse call, then the pick call.
const fakeChat = (parse: unknown, pick: (req: GroqJsonRequest) => unknown) =>
  jest.fn(async (req: GroqJsonRequest) => (req.schemaName === 'grocery_request' ? parse : pick(req)));

const PARSED = { items: [
  { name: 'Milk', query: 'milk', amount: '1 litre' },
  { name: 'Eggs', query: 'eggs', amount: '24 pieces' },
  { name: 'Saffron', query: 'saffron', amount: '' },
] };

// Twin searches go through the real match ladder (searchForMatch) on a mocked api.
let single: jest.SpyInstance;
const singleAnswers = (byQuery: Record<string, UnifiedProduct[] | Error>) =>
  single.mockImplementation(async (_p: string, q: string) => {
    const r = byQuery[q];
    if (r instanceof Error) throw r;
    return r || [];
  });

beforeEach(() => {
  sync.isAddressSyncing.mockReset().mockReturnValue(false);
  sync.waitForAddressSync.mockReset().mockResolvedValue(undefined);
  single = jest.spyOn(api, 'searchSingle').mockResolvedValue([]);
});

afterEach(() => {
  single.mockRestore();
});

describe('buildAiBasket', () => {
  it('parses, searches each item, and keeps only valid picks from the fetched results', async () => {
    const search = jest.fn(async (q: string) => CATALOG[q] ?? []);
    const chat = fakeChat(PARSED, (req) => {
      const sent = JSON.parse(req.user);
      // The LLM only sees items that have candidates, with refs instead of ids.
      expect(sent.items.map((i: any) => i.item)).toEqual(['Milk', 'Eggs']);
      expect(req.user).not.toContain('blinkit-milk');
      const milkRef = sent.items[0].candidates[0].ref;
      const eggsRef = sent.items[1].candidates[0].ref;
      return { picks: [
        { index: 0, ref: milkRef, units: 2, reason: '2 x 500 ml' },
        { index: 1, ref: eggsRef, units: 4, reason: '4 x 6 eggs' },
        { index: 2, ref: milkRef, units: 1, reason: 'invented' },
      ] };
    });
    const progress: AiProgress[] = [];
    const res = await buildAiBasket('milk 1L, 2 dozen eggs and saffron', { proxy: PROXY, search, chat, onProgress: p => progress.push(p) });

    expect(search.mock.calls.map(c => c[0])).toEqual(['milk', 'eggs', 'saffron']);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls.map(c => c[0].proxy)).toEqual([PROXY, PROXY]);
    expect(res.requested.map(r => r.name)).toEqual(['Milk', 'Eggs', 'Saffron']);
    expect(res.picks.map(p => [p.item.name, p.product.id, p.units])).toEqual([['Milk', 'blinkit-milk', 2], ['Eggs', 'blinkit-eggs', 4]]);
    // Same product on the other store is attached from the same search results.
    expect(res.picks[0].product.platformPrices?.swiggy?.id).toBe('swiggy-milk');
    expect(res.unmatched).toEqual([{ index: 2, item: res.requested[2], reason: 'No results on Blinkit or Instamart' }]);
    // Eggs had no Instamart row: the ladder ran there and found nothing.
    expect(single.mock.calls[0].slice(0, 2)).toEqual(['swiggy', 'Farm Eggs 6 pcs']);
    expect(res.unlinked).toEqual([expect.objectContaining({ index: 1, platform: 'swiggy', reason: 'no similar product', suggestion: null })]);
    expect(progress.map(p => p.stage)).toEqual(['parsing', 'searching', 'searching', 'searching', 'choosing', 'linking']);
  });

  it('skips the pick call when no item has usable results', async () => {
    const chat = fakeChat({ items: [{ name: 'Saffron', query: 'saffron', amount: '' }] }, () => { throw new Error('should not be called'); });
    const res = await buildAiBasket('saffron', { proxy: PROXY, search: async () => [], chat });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(res.picks).toEqual([]);
    expect(res.unmatched).toHaveLength(1);
  });

  it('treats a failing or junk search as no results for that item only', async () => {
    const search = jest.fn(async (q: string) => {
      if (q === 'milk') throw new Error('store down');
      if (q === 'eggs') return 'nope' as any;
      return [];
    });
    const chat = fakeChat(PARSED, () => ({ picks: [] }));
    const res = await buildAiBasket('stuff', { proxy: PROXY, search, chat });
    expect(res.unmatched.map(u => u.item.name)).toEqual(['Milk', 'Eggs', 'Saffron']);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('rejects empty input, a missing proxy config, and requests with no grocery items', async () => {
    const chat = fakeChat({ items: [] }, () => ({ picks: [] }));
    await expect(buildAiBasket('   ', { proxy: PROXY, search: async () => [], chat })).rejects.toBeInstanceOf(AiModeError);
    await expect(buildAiBasket('milk', { proxy: null, search: async () => [], chat })).rejects.toThrow(/AI mode is not configured/);
    expect(chat).not.toHaveBeenCalled();
    await expect(buildAiBasket('tell me a joke', { proxy: PROXY, search: async () => [], chat })).rejects.toThrow(/No grocery items/);
  });

  it('caps the request text sent to the LLM', async () => {
    const chat = fakeChat({ items: [] }, () => ({ picks: [] }));
    await buildAiBasket('milk '.repeat(500), { proxy: PROXY, search: async () => [], chat }).catch(() => {});
    expect(chat.mock.calls[0][0].user.length).toBeLessThanOrEqual(600);
  });

  it('propagates AI service errors (e.g. a rejected app token)', async () => {
    const chat = jest.fn(async () => { throw new GroqError('The AI service rejected this app. Check EXPO_PUBLIC_AI_PROXY_TOKEN.', 'auth', 401); });
    await expect(buildAiBasket('milk', { proxy: PROXY, search: async () => [], chat })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('stops searching once cancelled', async () => {
    const ctrl = new AbortController();
    const search = jest.fn(async (q: string) => {
      ctrl.abort();
      return CATALOG[q] ?? [];
    });
    const chat = fakeChat(PARSED, () => ({ picks: [] }));
    await expect(buildAiBasket('milk eggs', { proxy: PROXY, search, chat, signal: ctrl.signal })).rejects.toMatchObject({ kind: 'aborted' });
    expect(search).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

describe('buildAiBasket: finding twins on the other store', () => {
  // The LLM takes the first candidate of every item.
  const pickFirst = (req: GroqJsonRequest) => ({
    picks: JSON.parse(req.user).items.map((i: any) => ({ index: i.index, ref: i.candidates[0].ref, units: 1, reason: '' })),
  });
  const parsed = (...queries: string[]) => ({ items: queries.map(q => ({ name: q, query: q, amount: '' })) });
  const ATTA = 'Aashirvaad Superior MP Chakki Atta - l kg (Godihittu)';
  const atta = bl('atta', ATTA, { quantity: '1 kg', price: 74 });
  const multigrain = sw('multi', 'Aashirvaad Multigrain Atta', { quantity: '1 kg', price: 80 });
  const twin = sw('atta', 'Aashirvaad Superior MP Atta', { quantity: '1 kg', price: 72 });

  it('walks the ladder for a twin the item search missed and attaches only an auto match', async () => {
    singleAnswers({ 'aashirvaad mp chakki atta': [multigrain, twin] });
    const progress: AiProgress[] = [];
    const res = await buildAiBasket('atta', {
      proxy: PROXY, search: async () => [atta, multigrain], chat: fakeChat(parsed('atta'), pickFirst), onProgress: p => progress.push(p),
    });
    expect(single.mock.calls.map(c => [c[0], c[1]])).toEqual([['swiggy', ATTA], ['swiggy', 'aashirvaad mp chakki atta']]);
    expect(res.picks[0].product.platformPrices?.swiggy?.id).toBe('swiggy-atta');
    expect(res.unlinked).toEqual([]);
    expect(progress.filter(p => p.stage === 'linking')).toEqual([{ stage: 'linking', done: 0, total: 1, current: 'atta', platform: 'swiggy' }]);
  });

  it('reports a suggestion and its reasons but does not link it', async () => {
    const tomato = bl('tomato', 'Desi Tomato', { quantity: '500 g', price: 25 });
    const plain = sw('tomato', 'Tomato', { quantity: '500 g', price: 20 });
    singleAnswers({ 'Desi Tomato': [plain] });
    const res = await buildAiBasket('tomato', {
      proxy: PROXY, search: async () => [tomato, sw('onion', 'Onion', { quantity: '1 kg' })], chat: fakeChat(parsed('tomato'), pickFirst),
    });
    expect(res.picks[0].product.platformPrices?.swiggy).toBeUndefined();
    expect(res.unlinked).toEqual([expect.objectContaining({ index: 0, platform: 'swiggy', reason: 'missing words: desi' })]);
    expect(res.unlinked[0].suggestion).toEqual(expect.objectContaining({ product: plain, reasons: ['missing words: desi'] }));
    // A suggestion does not stop the ladder (the exact twin may be further down).
    expect(single.mock.calls.map(c => c[1])).toEqual(['Desi Tomato', 'tomato']);
  });

  it('caps the extra searches and reports what it could not check', async () => {
    const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
    const rows: Record<string, UnifiedProduct[]> = {};
    names.forEach(n => { rows[n] = [bl(n, `Zork ${n} Premium Thing`, { quantity: '1 kg' })]; });
    rows.Alpha.push(sw('other', 'Unrelated Item', { quantity: '1 kg' }));
    const res = await buildAiBasket('stuff', {
      proxy: PROXY, search: async q => rows[q] || [], chat: fakeChat(parsed(...names), pickFirst),
    });
    // 8 twins x 3 rungs would be 24 searches; the budget stops at 20.
    expect(single).toHaveBeenCalledTimes(MAX_TWIN_SEARCHES);
    expect(res.unlinked).toHaveLength(8);
    expect(res.unlinked[7].reason).toBe('Not searched: search limit reached');
    expect(res.picks).toHaveLength(8);
  });

  it('does not search a store that answered none of the item searches', async () => {
    const res = await buildAiBasket('atta', { proxy: PROXY, search: async () => [atta], chat: fakeChat(parsed('atta'), pickFirst) });
    expect(single).not.toHaveBeenCalled();
    expect(res.unlinked).toEqual([]);
  });

  it('keeps the pick when a twin search fails, with the reason', async () => {
    singleAnswers({ [ATTA]: new Error('net down') });
    const findTwin = jest.fn(async (...args: Parameters<TwinSearch>) => searchForMatch(args[0], args[1], { ...args[2], seed: [] }));
    const res = await buildAiBasket('atta', {
      proxy: PROXY, search: async () => [atta, multigrain], chat: fakeChat(parsed('atta'), pickFirst), findTwin,
    });
    expect(findTwin).toHaveBeenCalledWith('swiggy', { name: ATTA, unit: '1 kg', price: 74 }, expect.objectContaining({ maxQueries: 3 }));
    expect(res.picks).toHaveLength(1);
    expect(res.unlinked).toEqual([expect.objectContaining({ platform: 'swiggy', reason: 'Search failed: net down' })]);
  });

  it('stops finding twins once cancelled', async () => {
    const ctrl = new AbortController();
    single.mockImplementation(async () => { ctrl.abort(); return []; });
    await expect(buildAiBasket('atta', {
      proxy: PROXY, search: async () => [atta, multigrain], chat: fakeChat(parsed('atta'), pickFirst), signal: ctrl.signal,
    })).rejects.toMatchObject({ kind: 'aborted' });
    expect(single).toHaveBeenCalledTimes(1);
  });
});

describe('searchAllStores', () => {
  it('waits for an address sync, then runs the normal two-store search', async () => {
    sync.isAddressSyncing.mockReturnValue(true);
    const spy = jest.spyOn(api, 'search').mockResolvedValue([bl('1', 'Milk')]);
    expect(await searchAllStores('milk')).toHaveLength(1);
    expect(sync.waitForAddressSync).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith('milk');
  });

  it('resolves to [] when the search throws', async () => {
    jest.spyOn(api, 'search').mockRejectedValue(new Error('boom'));
    expect(await searchAllStores('milk')).toEqual([]);
    expect(sync.waitForAddressSync).not.toHaveBeenCalled();
  });
});
