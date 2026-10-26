import { api, UnifiedProduct } from '../api';
import { searchForMatch, MAX_POOL } from '../matchSearch';
import { product } from './fixtures';

const sw = (id: string, title: string, quantity: string, price: number, over: Partial<UnifiedProduct> = {}) =>
  product({ id: `swiggy-${id}`, platform: 'swiggy', title, quantity, price, ...over });

const target = { name: 'Amul Taaza Homogenised Toned Milk 500 ml', unit: '500 ml', price: 28 };
const twin = sw('1', 'Amul Taaza Toned Fresh Milk', '500 ml', 28);

let search: jest.SpyInstance;
beforeEach(() => {
  search = jest.spyOn(api, 'searchSingle');
});

const respond = (byQuery: Record<string, UnifiedProduct[] | Error>) =>
  search.mockImplementation(async (_p: string, q: string) => {
    const r = byQuery[q];
    if (r instanceof Error) throw r;
    return r || [];
  });

describe('searchForMatch', () => {
  it('stops after the first query when it finds the twin', async () => {
    respond({ [target.name]: [twin] });
    const r = await searchForMatch('swiggy', target);
    expect(r.decision.band).toBe('auto');
    expect(r.decision.best?.candidate.id).toBe('swiggy-1');
    expect(r.queries).toEqual([target.name]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('swiggy', target.name, { throwOnError: true, includeOutOfStock: true });
  });

  it('walks the ladder until a rung finds it, pooling earlier results', async () => {
    const decoy = sw('9', 'Amul Gold Full Cream Milk', '500 ml', 34);
    respond({ [target.name]: [], 'amul taaza toned milk': [decoy], 'amul taaza toned': [twin, decoy] });
    const r = await searchForMatch('swiggy', target);
    expect(r.queries).toEqual([target.name, 'amul taaza toned milk', 'amul taaza toned']);
    expect(r.decision.band).toBe('auto');
    expect(r.candidates.map(c => c.id)).toEqual(['swiggy-1', 'swiggy-9']); // de-duplicated, best first
  });

  it('runs every rung and reports none when nothing is close', async () => {
    respond({});
    const r = await searchForMatch('swiggy', target);
    expect(r.queries).toEqual([target.name, 'amul taaza toned milk', 'amul taaza toned', 'milk']);
    expect(r.decision.band).toBe('none');
    expect(r.candidates).toEqual([]);
  });

  it('keeps searching past a suggestion and settles on the exact size', async () => {
    const litre = sw('2', 'Amul Taaza Toned Milk', '1 L', 54);
    respond({ [target.name]: [litre], 'amul taaza toned milk': [twin] });
    const r = await searchForMatch('swiggy', target);
    expect(r.decision.band).toBe('auto');
    expect(r.decision.best?.candidate.id).toBe('swiggy-1');
    expect(r.decision.alternatives[0].candidate.id).toBe('swiggy-2');
  });

  it('caps the pool', async () => {
    const many = Array.from({ length: 25 }, (_, i) => sw(`m${i}`, `Other Thing ${i}`, '1 kg', 10));
    const more = Array.from({ length: 25 }, (_, i) => sw(`n${i}`, `Else ${i}`, '1 kg', 10));
    respond({ [target.name]: many, 'amul taaza toned milk': more });
    const r = await searchForMatch('swiggy', target);
    expect(r.candidates).toHaveLength(MAX_POOL);
  });

  it('throws when the first search fails, so the cell can offer Retry', async () => {
    respond({ [target.name]: new Error('net down') });
    await expect(searchForMatch('swiggy', target)).rejects.toThrow('net down');
  });

  it('keeps what it has when a later search fails', async () => {
    const litre = sw('2', 'Amul Taaza Toned Milk', '1 L', 54);
    respond({ [target.name]: [litre], 'amul taaza toned milk': new Error('timeout') });
    const r = await searchForMatch('swiggy', target);
    expect(r.queries).toEqual([target.name]);
    expect(r.decision.band).toBe('suggest');
    expect(r.decision.reasons[0]).toMatch(/^different size 500 ml vs 1 L/);
  });

  it('offers an out-of-stock twin as a suggestion, flagged', async () => {
    respond({ [target.name]: [{ ...twin, inStock: false }] });
    const r = await searchForMatch('swiggy', target);
    expect(r.decision.band).toBe('suggest');
    expect(r.decision.reasons).toContain('out of stock');
  });
});
