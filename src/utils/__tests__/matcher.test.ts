import { matchScore, pickBestMatch, nameTokens, nameSimilarity, sizeScore, isSameProduct } from '../matcher';

type P = { name: string; unit: string; price?: number };
const THRESHOLD = 0.5;

// Regression fixtures (migrated from scripts/matcher-fixtures.ts).
const same: [P, P][] = [
  [{ name: 'Tata Salt', unit: '1 kg', price: 28 }, { name: 'Tata Salt Vacuum Evaporated', unit: '1 kg', price: 29 }],
  [{ name: 'Amul Butter Salted', unit: '100 g', price: 58 }, { name: 'Amul Salted Butter', unit: '100 g', price: 60 }],
  [{ name: 'Tomatoes', unit: '500 g', price: 30 }, { name: 'Tomato', unit: '500 g', price: 32 }],
  [{ name: 'Mother Dairy Dahi', unit: '400 g', price: 40 }, { name: 'Mother Dairy Curd', unit: '400 g', price: 42 }],
  [{ name: 'Aashirvaad Atta', unit: '5 kg', price: 260 }, { name: 'Aashirvaad Atta', unit: '5 kg', price: 255 }],
  [{ name: 'Coca-Cola Zero', unit: '750 ml', price: 40 }, { name: 'Coca Cola Zero Sugar', unit: '750 ml', price: 40 }],
];
const different: [P, P][] = [
  [{ name: 'English Oven Pav Bread', unit: '200 g', price: 30 }, { name: 'English Oven Milk Bread', unit: '400 g', price: 45 }],
  [{ name: 'English Oven Pav Bread', unit: '400 g', price: 40 }, { name: 'English Oven Milk Bread', unit: '400 g', price: 40 }],
  [{ name: 'Amul Butter Salted', unit: '100 g', price: 58 }, { name: 'Amul Butter Unsalted', unit: '100 g', price: 58 }],
  [{ name: 'Amul Toned Milk', unit: '500 ml', price: 30 }, { name: 'Amul Full Cream Milk', unit: '500 ml', price: 36 }],
  [{ name: 'Tata Salt', unit: '1 kg', price: 28 }, { name: 'Aashirvaad Salt', unit: '1 kg', price: 28 }],
  [{ name: 'Coca-Cola', unit: '750 ml', price: 40 }, { name: 'Coca-Cola Zero', unit: '750 ml', price: 40 }],
  [{ name: 'Atta', unit: '1 kg', price: 60 }, { name: 'Maida', unit: '1 kg', price: 60 }],
  [{ name: 'Red Chilli Powder', unit: '100 g', price: 40 }, { name: 'Green Chilli Powder', unit: '100 g', price: 40 }],
  [{ name: 'Tata Salt', unit: '1 kg', price: 28 }, { name: 'Tata Salt', unit: '1 L', price: 28 }],
];

describe('matchScore regression fixtures', () => {
  it.each(same)('matches: %j ~ %j', (a, b) => {
    expect(matchScore(a, b)).toBeGreaterThanOrEqual(THRESHOLD);
  });
  it.each(different)('does NOT match: %j !~ %j', (a, b) => {
    expect(matchScore(a, b)).toBeLessThan(THRESHOLD);
  });
});

describe('nameTokens', () => {
  it('lowercases, drops stopwords and dedupes', () => {
    expect(nameTokens('Fresh Tata Salt, the Salt Pack')).toEqual(['tata', 'salt']);
  });
  it('applies synonyms and plural normalization', () => {
    expect(nameTokens('Dahi')).toEqual(['curd']);
    expect(nameTokens('Tomatoes')).toEqual(['tomato']);
    expect(nameTokens('Biscuits')).toEqual(['biscuit']);
  });
  it('handles empty input', () => {
    expect(nameTokens(undefined)).toEqual([]);
  });
});

describe('nameSimilarity', () => {
  it('is 1 for identical names and 0 for empty/conflicting ones', () => {
    expect(nameSimilarity('Tata Salt', 'Tata Salt')).toBe(1);
    expect(nameSimilarity('', 'Tata Salt')).toBe(0);
    expect(nameSimilarity('Salted Butter', 'Unsalted Butter')).toBe(0);
  });
  it('ignores pack size in the name', () => {
    expect(nameSimilarity('Tata Salt 1 kg', 'Tata Salt 500 g')).toBe(1);
  });
});

describe('sizeScore', () => {
  it.each([
    [{ unit: '500 g' }, { unit: '500 g' }, 1],
    [{ unit: '500 g' }, { unit: '0.5 kg' }, 1],
    [{ unit: '500 g' }, { unit: '540 g' }, 0.9],
    [{ unit: '500 g' }, { unit: '600 g' }, 0.6],
    [{ unit: '500 g' }, { unit: '1 kg' }, 0.5],
    [{ unit: '500 g' }, { unit: '5 kg' }, 0],
    [{ unit: '500 g' }, { unit: '500 ml' }, 0],
    [{ unit: '500 g' }, { unit: 'big' }, 0.4],
  ])('%j vs %j = %d', (a, b, expected) => {
    expect(sizeScore(a, b)).toBe(expected);
  });
});

describe('isSameProduct', () => {
  it('accepts wording differences at equal size', () => {
    expect(isSameProduct({ name: 'Amul Butter Salted', unit: '100 g' }, { name: 'Amul Salted Butter', unit: '100 g' })).toBe(true);
  });
  it('rejects different size, variant, or size class', () => {
    expect(isSameProduct({ name: 'Amul Butter', unit: '100 g' }, { name: 'Amul Butter', unit: '500 g' })).toBe(false);
    expect(isSameProduct({ name: 'Pav Bread', unit: '200 g' }, { name: 'Milk Bread', unit: '200 g' })).toBe(false);
    expect(isSameProduct({ name: 'Tata Salt', unit: '1 kg' }, { name: 'Tata Salt', unit: '1 L' })).toBe(false);
  });
});

describe('pickBestMatch', () => {
  const candidates = [
    { name: 'Amul Butter', unit: '100 g', price: 58 },
    { name: 'Amul Butter', unit: '500 g', price: 285 },
    { name: 'Amul Cheese', unit: '500 g', price: 280 },
  ];
  it('prefers the same pack size', () => {
    const pick = pickBestMatch({ name: 'Amul Butter', unit: '500 g', price: 280 }, candidates);
    expect(pick?.candidate.unit).toBe('500 g');
    expect(pick?.candidate.name).toBe('Amul Butter');
  });
  it('returns null for no candidates or nothing above threshold', () => {
    expect(pickBestMatch({ name: 'Amul Butter', unit: '500 g' }, [])).toBeNull();
    expect(pickBestMatch({ name: 'Amul Butter', unit: '500 g' }, null)).toBeNull();
    expect(pickBestMatch({ name: 'Amul Butter', unit: '500 g' }, [{ name: 'Maggi Noodles', unit: '70 g' }])).toBeNull();
  });
  it('flags near-tied runners-up as ambiguous', () => {
    const pick = pickBestMatch({ name: 'Aashirvaad Atta', unit: '5 kg', price: 260 }, [
      { name: 'Aashirvaad Atta', unit: '5 kg', price: 260 },
      { name: 'Aashirvaad Atta', unit: '5 kg', price: 262 },
    ]);
    expect(pick?.ambiguous).toBe(true);
  });
  it('breaks ties by closest price', () => {
    const pick = pickBestMatch({ name: 'Milk', unit: '500 ml', price: 24 }, [
      { name: 'Milk', unit: '500 ml x 2', price: 48 },
      { name: 'Milk', unit: '500 ml', price: 24 },
    ]);
    expect(pick?.candidate.unit).toBe('500 ml');
  });
  it('works with UnifiedProduct-shaped rows (title/quantity)', () => {
    const pick = pickBestMatch({ name: 'Tata Salt', unit: '1 kg' }, [{ title: 'Tata Salt', quantity: '1 kg', price: 28 }]);
    expect(pick?.candidate.title).toBe('Tata Salt');
  });
});
