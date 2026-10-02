import { shouldShowBlinkitDirectNote, shouldShowStockBadge } from '../stockNotes';

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

describe('shouldShowStockBadge', () => {
  it('shows when fewer than 5 units remain beyond the basket quantity', () => {
    expect(shouldShowStockBadge(4, 1)).toBe(true);
    expect(shouldShowStockBadge(25, 21)).toBe(true);
    expect(shouldShowStockBadge(25, 25)).toBe(true);
  });
  it('hides when 5 or more remain', () => {
    expect(shouldShowStockBadge(25, 1)).toBe(false);
    expect(shouldShowStockBadge(25, 20)).toBe(false);
    expect(shouldShowStockBadge(6, 1)).toBe(false);
  });
  it('hides when stock is unknown or zero', () => {
    expect(shouldShowStockBadge(undefined, 99)).toBe(false);
    expect(shouldShowStockBadge(0, 1)).toBe(false);
  });
});
