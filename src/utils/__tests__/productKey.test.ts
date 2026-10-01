import { productKey, itemName, itemUnit, liveKey, stripSizeToken, familyKey, variantSize } from '../productKey';

describe('productKey', () => {
  it('lowercases and dash-joins name and unit', () => {
    expect(productKey('Tata Salt', '1 kg')).toBe('tata-salt-1-kg');
  });
  it('trims leading/trailing separators and handles empty input', () => {
    expect(productKey('  --Amul!! ', '')).toBe('amul');
    expect(productKey(undefined)).toBe('');
  });
  it('caps the key at 80 characters', () => {
    expect(productKey('a'.repeat(200)).length).toBe(80);
  });
});

describe('itemName / itemUnit / liveKey', () => {
  it('reads both match-target and UnifiedProduct shapes', () => {
    expect(itemName({ name: 'A' })).toBe('A');
    expect(itemName({ title: 'B' })).toBe('B');
    expect(itemUnit({ unit: '1 kg' })).toBe('1 kg');
    expect(itemUnit({ quantity: '2 L' })).toBe('2 L');
    expect(liveKey({ title: 'Milk', quantity: '500 ml' })).toBe('milk-500-ml');
  });
  it('tolerates null/undefined', () => {
    expect(itemName(null)).toBe('');
    expect(itemUnit(undefined)).toBe('');
  });
});

describe('stripSizeToken', () => {
  it.each([
    ['Tata Salt 1 kg', 'Tata Salt'],
    ['Amul Butter 500g', 'Amul Butter'],
    ['Milk 2 x 500 ml', 'Milk'],
    ['Biscuits (Pack of 3)', 'Biscuits'],
    ['Chips 100 g x 3', 'Chips'],
    ['Plain Name', 'Plain Name'],
  ])('%s -> %s', (input, expected) => {
    expect(stripSizeToken(input)).toBe(expected);
  });
  it('handles empty/undefined', () => {
    expect(stripSizeToken(undefined)).toBe('');
    expect(stripSizeToken('')).toBe('');
  });
});

describe('familyKey', () => {
  it('is identical across pack sizes of the same product', () => {
    expect(familyKey({ name: 'Tata Salt 1 kg' })).toBe(familyKey({ name: 'Tata Salt 500 g' }));
  });
});

describe('variantSize', () => {
  it.each([
    [{ unit: '500 g' }, 500],
    [{ unit: '1 kg' }, 1000],
    [{ unit: '1.5 L' }, 1500],
    [{ unit: '750 ml' }, 750],
    [{ unit: '2 x 500 ml' }, 1000],
    [{ unit: '500 ml x 2' }, 1000],
    [{ unit: 'Pack of 3 100 g' }, 300],
    [{ unit: '6 pcs' }, 6],
  ])('%j -> %d', (item, expected) => {
    expect(variantSize(item)).toBe(expected);
  });
  it('falls back to the name when no unit is present', () => {
    expect(variantSize({ name: 'Rice 5 kg' })).toBe(5000);
  });
  it('is Infinity when unparseable', () => {
    expect(variantSize({ unit: 'large' })).toBe(Infinity);
    expect(variantSize(null)).toBe(Infinity);
  });
});
