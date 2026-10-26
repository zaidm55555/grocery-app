import {
  productKey, itemName, itemUnit, liveKey, stripSizeToken, familyKey, variantSize, foldText, stripAllSizes,
  parseQuantity, quantityOf, isUnknownQuantity,
} from '../productKey';

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

describe('foldText', () => {
  it('folds accents, joins apostrophes and spells out &', () => {
    expect(foldText('Nestlé Café')).toBe('nestle cafe');
    expect(foldText("Lay's Haldiram’s")).toBe('lays haldirams');
    expect(foldText('Cream & Onion')).toBe('cream  and  onion');
    expect(foldText(undefined)).toBe('');
  });
});

describe('stripAllSizes', () => {
  it.each([
    ['Amul Taaza 500 ml Toned Milk', 'amul taaza toned milk'],
    ['Coca-Cola 6 x 300 ml Can', 'coca-cola can'],
    ['Eggs 1 Dozen Tray', 'eggs tray'],
    ['Lays Classic (Pack of 3)', 'lays classic'],
    ['Banana Robusta 6 pcs (Approx. 1 - 1.2 kg)', 'banana robusta'],
    ['Pepsi 2.25 Ltr', 'pepsi'],
    ['Britannia 50-50 Maska Chaska', 'britannia 50-50 maska chaska'],
  ])('%s -> %s', (input, expected) => {
    expect(stripAllSizes(input)).toBe(expected);
  });
});

describe('stripSizeToken: wider units', () => {
  it.each([['Pepsi 2.25 Ltr', 'Pepsi'], ['Eggs 12 Pieces', 'Eggs'], ['Vitamin C 500 mg', 'Vitamin C']])('%s -> %s', (input, expected) => {
    expect(stripSizeToken(input)).toBe(expected);
  });
});

describe('parseQuantity', () => {
  it.each([
    ['500 g', { weight: 500, packs: 1, primary: 'weight' }],
    ['250 mg', { weight: 0.25, packs: 1, primary: 'weight' }],
    ['1 ltr', { volume: 1000, packs: 1, primary: 'volume' }],
    ['2 Litres', { volume: 2000, packs: 1, primary: 'volume' }],
    ['500 millilitre', { volume: 500, packs: 1, primary: 'volume' }],
    ['1 dozen', { count: 12, packs: 1, primary: 'count' }],
    ['Half Dozen', { count: 6, packs: 1, primary: 'count' }],
    ['2 dozen', { count: 24, packs: 1, primary: 'count' }],
    ['0.95 - 1.05 kg', { weight: 1000, packs: 1, primary: 'weight' }],
    ['3 pcs (approx. 450 - 600 g)', { count: 3, weight: 525, packs: 1, primary: 'count' }],
    ['2 x 500 ml', { volume: 1000, packs: 2, primary: 'volume' }],
    ['500 ml x 2', { volume: 1000, packs: 2, primary: 'volume' }],
    ['6 × 300 ml', { volume: 1800, packs: 6, primary: 'volume' }],
    ['280 g (4 x 70 g)', { weight: 280, packs: 4, primary: 'weight' }],
    ['52 g (Pack of 3)', { weight: 156, packs: 3, primary: 'weight' }],
    ['Combo of 2 - 1 kg', { weight: 2000, packs: 2, primary: 'weight' }],
    ['Pack of 6', { count: 6, packs: 1, primary: 'count' }],
    ['6 pcs (Pack of 6)', { count: 6, packs: 6, primary: 'count' }],
    ['1 pack (6 pieces)', { count: 6, packs: 1, primary: 'count' }],
  ])('%s', (raw, expected) => {
    expect(parseQuantity(raw)).toEqual(expected);
  });
  it('is null when there is no size', () => {
    expect(parseQuantity('large')).toBeNull();
    expect(parseQuantity('')).toBeNull();
    expect(parseQuantity('1 pack')).toBeNull();
    expect(parseQuantity('Maggi 2-Minute Noodles')).toBeNull();
  });
});

describe('quantityOf', () => {
  it('treats the "1 unit" placeholder as unknown and falls back to the title', () => {
    expect(isUnknownQuantity('1 unit')).toBe(true);
    expect(isUnknownQuantity('6 units')).toBe(false);
    expect(quantityOf({ name: 'Amul Butter', unit: '1 unit' })).toBeNull();
    expect(quantityOf({ name: 'Tata Salt 1 kg', unit: '1 unit' })).toEqual({ weight: 1000, packs: 1, primary: 'weight' });
  });
  it('marks a multipack named only in the title as uncertain', () => {
    expect(quantityOf({ name: 'Tata Salt (Pack of 2)', unit: '1 kg' })).toMatchObject({ weight: 1000, uncertain: true });
  });
});

describe('variantSize: parser fixes', () => {
  it.each([
    [{ unit: '500 millilitre' }, 500],
    [{ unit: '1 dozen' }, 12],
    [{ unit: '1 ltr' }, 1000],
    [{ unit: '250 mg' }, 0.25],
    [{ unit: '280 g (4 x 70 g)' }, 280],
  ])('%j -> %d', (item, expected) => {
    expect(variantSize(item)).toBe(expected);
  });
  it('is Infinity for the "1 unit" placeholder', () => {
    expect(variantSize({ unit: '1 unit' })).toBe(Infinity);
  });
});
