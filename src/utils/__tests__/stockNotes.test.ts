import { getStockFooter, shouldShowBlinkitDirectNote, STOCK_BADGE_MAX, StockVariant } from '../stockNotes';

const v = (platform: 'blinkit' | 'swiggy', over: Partial<StockVariant> = {}): StockVariant => ({
  platform, isOos: false, isCapped: false, ...over,
});

describe('getStockFooter', () => {
  it('lists every in-stock app when any has low known stock (the 12 vs 3 case)', () => {
    expect(getStockFooter([v('blinkit', { platformLimit: 12 }), v('swiggy', { platformLimit: 3 })])).toEqual([
      { platform: 'blinkit', limit: 12, capped: false },
      { platform: 'swiggy', limit: 3, capped: false },
    ]);
  });

  it('shows even when both limits are equal (previously hidden)', () => {
    expect(getStockFooter([v('blinkit', { platformLimit: 5 }), v('swiggy', { platformLimit: 5 })])).toHaveLength(2);
  });

  it('shows when only one app has a known limit; unknown one has undefined limit', () => {
    expect(getStockFooter([v('blinkit', { platformLimit: 4 }), v('swiggy')])).toEqual([
      { platform: 'blinkit', limit: 4, capped: false },
      { platform: 'swiggy', limit: undefined, capped: false },
    ]);
  });

  it('flags capped apps', () => {
    const r = getStockFooter([v('blinkit', { platformLimit: 12 }), v('swiggy', { platformLimit: 3, isCapped: true })]);
    expect(r!.map(e => e.capped)).toEqual([false, true]);
  });

  it('is hidden when stock is plentiful everywhere', () => {
    expect(getStockFooter([v('blinkit', { platformLimit: 50 }), v('swiggy', { platformLimit: 99 })])).toBeNull();
    expect(getStockFooter([v('blinkit'), v('swiggy')])).toBeNull();
  });

  it('uses the ≤ threshold boundary', () => {
    expect(getStockFooter([v('blinkit', { platformLimit: STOCK_BADGE_MAX }), v('swiggy')])).not.toBeNull();
    expect(getStockFooter([v('blinkit', { platformLimit: STOCK_BADGE_MAX + 1 }), v('swiggy')])).toBeNull();
  });

  it('is hidden for a single priced app', () => {
    expect(getStockFooter([v('blinkit', { platformLimit: 2 })])).toBeNull();
    expect(getStockFooter([])).toBeNull();
  });

  it('excludes out-of-stock apps and hides if that leaves fewer than two', () => {
    expect(getStockFooter([v('blinkit', { platformLimit: 0, isOos: true }), v('swiggy', { platformLimit: 3 })])).toBeNull();
  });

  it('ignores a low limit that belongs to an out-of-stock app', () => {
    expect(getStockFooter([v('blinkit', { platformLimit: 1, isOos: true }), v('swiggy', { platformLimit: 40 })])).toBeNull();
  });
});

describe('shouldShowBlinkitDirectNote', () => {
  const base = { blinkitLinked: true, bridgeConnected: false, storeFilter: 'all' as const };
  it('shows when linked, bridge down, searching all or blinkit', () => {
    expect(shouldShowBlinkitDirectNote(base)).toBe(true);
    expect(shouldShowBlinkitDirectNote({ ...base, storeFilter: 'blinkit' })).toBe(true);
  });
  it('hides when the bridge is connected', () => {
    expect(shouldShowBlinkitDirectNote({ ...base, bridgeConnected: true })).toBe(false);
  });
  it('hides when Blinkit is not linked', () => {
    expect(shouldShowBlinkitDirectNote({ ...base, blinkitLinked: false })).toBe(false);
  });
  it('hides when filtered to Swiggy only', () => {
    expect(shouldShowBlinkitDirectNote({ ...base, storeFilter: 'swiggy' })).toBe(false);
  });
});
