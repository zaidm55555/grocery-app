import { emptySearchOutcome, isLocationSearchError, splitSearchErrors } from '../searchOutcome';

const BOTH = { blinkit: true, swiggy: true };
const base = { searchedQuery: 'milk', searchFailed: false, platformErrors: {}, linked: BOTH, storeFilter: 'all' as const };

describe('isLocationSearchError', () => {
  it.each([
    'BLINKIT_UNAVAILABLE: Cannot search Blinkit on your current location.',
    'SWIGGY_UNAVAILABLE: no',
    'SWIGGY_TOO_FAR',
    'BLINKIT_NO_ADDRESS',
  ])('reads %s as "cannot deliver here"', (msg) => {
    expect(isLocationSearchError(msg)).toBe(true);
  });

  it.each(['Blinkit API error: 403', 'Network request failed', 'Swiggy search/v2 API error: 500', '', undefined, null])(
    'reads %p as a failed request',
    (msg) => { expect(isLocationSearchError(msg)).toBe(false); },
  );
});

describe('splitSearchErrors', () => {
  it('separates location errors from failures', () => {
    expect(splitSearchErrors({ blinkit: 'Blinkit API error: 403', swiggy: 'SWIGGY_UNAVAILABLE: no' })).toEqual({
      location: { swiggy: 'SWIGGY_UNAVAILABLE: no' },
      failed: { blinkit: 'Blinkit API error: 403' },
    });
  });
});

describe('emptySearchOutcome', () => {
  it('is idle until a search has run: typed text alone is not "no results"', () => {
    expect(emptySearchOutcome({ ...base, searchedQuery: null })).toEqual({ kind: 'idle' });
  });

  it('says "no results" only when every store answered without an error', () => {
    expect(emptySearchOutcome(base)).toEqual({ kind: 'no_results' });
  });

  it('reports a failed store (bridge down, Cloudflare, HTTP error) instead of "no results"', () => {
    expect(emptySearchOutcome({ ...base, platformErrors: { blinkit: 'Blinkit API error: 403' } }))
      .toEqual({ kind: 'failed', platforms: ['blinkit'] });
  });

  it('reports a search that threw as failed on the linked stores', () => {
    expect(emptySearchOutcome({ ...base, searchFailed: true, linked: { blinkit: true, swiggy: false } }))
      .toEqual({ kind: 'failed', platforms: ['blinkit'] });
  });

  it('is out of range when every linked store in view cannot deliver', () => {
    expect(emptySearchOutcome({ ...base, platformErrors: { blinkit: 'BLINKIT_UNAVAILABLE: x', swiggy: 'SWIGGY_UNAVAILABLE: x' } }))
      .toEqual({ kind: 'out_of_range', platforms: ['blinkit', 'swiggy'] });
    expect(emptySearchOutcome({ ...base, linked: { blinkit: false, swiggy: true }, platformErrors: { swiggy: 'SWIGGY_UNAVAILABLE: x' } }))
      .toEqual({ kind: 'out_of_range', platforms: ['swiggy'] });
  });

  it('prefers the retry when one store is out of range and the other failed', () => {
    expect(emptySearchOutcome({ ...base, platformErrors: { blinkit: 'BLINKIT_UNAVAILABLE: x', swiggy: 'Network request failed' } }))
      .toEqual({ kind: 'failed', platforms: ['swiggy'] });
  });

  it('says "no results" when one store is out of range and the other answered empty', () => {
    expect(emptySearchOutcome({ ...base, platformErrors: { swiggy: 'SWIGGY_UNAVAILABLE: x' } })).toEqual({ kind: 'no_results' });
  });

  it('only weighs the store the filter shows', () => {
    const errs = { blinkit: 'Blinkit API error: 403' };
    expect(emptySearchOutcome({ ...base, storeFilter: 'swiggy', platformErrors: errs })).toEqual({ kind: 'no_results' });
    expect(emptySearchOutcome({ ...base, storeFilter: 'blinkit', platformErrors: errs })).toEqual({ kind: 'failed', platforms: ['blinkit'] });
    expect(emptySearchOutcome({ ...base, storeFilter: 'blinkit', platformErrors: { blinkit: 'BLINKIT_UNAVAILABLE: x' } }))
      .toEqual({ kind: 'out_of_range', platforms: ['blinkit'] });
  });
});
