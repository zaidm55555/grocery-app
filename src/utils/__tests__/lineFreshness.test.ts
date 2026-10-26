import { isListingVerified, isLineVerified, needsRefresh, stampIfVerified, REFRESH_TTL_MS, VERIFIED_TRUST_MS } from '../lineFreshness';
import { product, variant } from '../../services/__tests__/fixtures';

const MIN = 60 * 1000;
const NOW = 1_700_000_000_000;

describe('isListingVerified', () => {
  it('trusts a Blinkit listing only when the bridge answered it', () => {
    expect(isListingVerified('blinkit', { storeVerified: true })).toBe(true);
    expect(isListingVerified('blinkit', { storeVerified: false })).toBe(false);
    expect(isListingVerified('blinkit', {})).toBe(false);
  });

  it('trusts an Instamart listing unless it is explicitly flagged', () => {
    expect(isListingVerified('swiggy', {})).toBe(true);
    expect(isListingVerified('swiggy', { storeVerified: false })).toBe(false);
  });
});

describe('isLineVerified', () => {
  it('needs the source listing and every twin verified', () => {
    const src = product({ storeVerified: true });
    expect(isLineVerified(src)).toBe(true);
    expect(isLineVerified({ ...src, platformPrices: { swiggy: variant() } })).toBe(true);
    expect(isLineVerified(product({ storeVerified: false, platformPrices: { swiggy: variant() } }))).toBe(false);
    // Instamart line whose Blinkit twin came from the direct fallback
    const sw = product({ id: 'swiggy-1', platform: 'swiggy', platformPrices: { blinkit: variant({ id: 'blinkit-1', storeVerified: false }) } });
    expect(isLineVerified(sw)).toBe(false);
  });
});

describe('needsRefresh', () => {
  it('always re-checks a line that was never stamped', () => {
    expect(needsRefresh(product({ storeVerified: true }), NOW)).toBe(true);
  });

  it('trusts a verified line for the trust window', () => {
    const at = (age: number) => product({ storeVerified: true, refreshedAt: NOW - age });
    expect(needsRefresh(at(30 * MIN), NOW)).toBe(false);
    expect(needsRefresh(at(VERIFIED_TRUST_MS - 1), NOW)).toBe(false);
    expect(needsRefresh(at(VERIFIED_TRUST_MS + 1), NOW)).toBe(true);
  });

  it('keeps the 10-minute TTL for an unverified line', () => {
    const at = (age: number) => product({ storeVerified: false, refreshedAt: NOW - age });
    expect(needsRefresh(at(5 * MIN), NOW)).toBe(false);
    expect(needsRefresh(at(REFRESH_TTL_MS + 1), NOW)).toBe(true);
    expect(needsRefresh(at(30 * MIN), NOW)).toBe(true);
  });
});

describe('stampIfVerified', () => {
  it('stamps a line whose listings all came from the right store', () => {
    expect(stampIfVerified(product({ storeVerified: true, platformPrices: { swiggy: variant() } }), NOW).refreshedAt).toBe(NOW);
  });

  it('leaves an unverified line unstamped', () => {
    const p = product({ storeVerified: false });
    expect(stampIfVerified(p, NOW)).toBe(p);
  });

  it('drops an earlier stamp once an unverified twin joins the line', () => {
    const p = product({ storeVerified: true, refreshedAt: NOW - MIN, platformPrices: { swiggy: variant({ storeVerified: false }) } });
    const out = stampIfVerified(p, NOW);
    expect(out.refreshedAt).toBeUndefined();
    expect(needsRefresh(out, NOW)).toBe(true);
  });
});
