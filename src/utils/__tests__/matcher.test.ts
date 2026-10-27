import {
  matchScore, pickBestMatch, nameTokens, nameSimilarity, sizeScore, isSameProduct, scoreMatch, decideMatch,
  rankCandidates, buildQueryLadder, parseTitle, AUTO_MIN, SUGGEST_MIN, CROSS_BRAND_PRICE_TOLERANCE,
} from '../matcher';

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
  [{ name: 'Tata Salt', unit: '1 kg', price: 28 }, { name: 'Aashirvaad Sugar', unit: '1 kg', price: 48 }],
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

describe('nameTokens: normalisation fixes', () => {
  it('joins apostrophes instead of splitting them', () => {
    expect(nameTokens("Lay's Magic Masala")).toEqual(['lays', 'magic', 'masala']);
    expect(nameTokens("Haldiram's Bhujia")).toEqual(['haldiram', 'bhujia']);
  });
  it('folds accents instead of dropping the letter', () => {
    expect(nameTokens('Nestlé Milkmaid')).toEqual(['nestle', 'milkmaid']);
  });
  it('strips pack sizes anywhere in the title', () => {
    expect(nameTokens('Amul Taaza 500 ml Toned Milk')).toEqual(['amul', 'taaza', 'toned', 'milk']);
    expect(nameTokens('Coca-Cola 6 x 300 ml Can')).toEqual(['cocacola']);
  });
  it.each([
    ['Haldi', 'Turmeric'], ['Jeera Powder', 'Cumin Powder'], ['Pyaz', 'Onion'], ['Aloo', 'Potato'], ['Bhindi', 'Okra'],
    ['Lady Finger', 'Okra'], ['Whole Wheat Flour', 'Atta'], ['Coke', 'Coca Cola'], ['Thumbs Up', 'Thums Up'],
    ['Ashirwad Atta', 'Aashirvaad Atta'], ['Kali Mirch', 'Black Pepper'], ['Dhaniya Patta', 'Coriander Leaves'],
  ])('treats %s and %s as the same words', (a, b) => {
    expect(nameTokens(a)).toEqual(nameTokens(b));
  });
});

describe('nameSimilarity: strict symmetric similarity', () => {
  it('matches single-token generics with a Hindi alias', () => {
    expect(nameSimilarity('Onion', 'Onion (Pyaz)')).toBe(1);
  });
  it('still rejects one-sided qualifiers and conflicting variants', () => {
    expect(nameSimilarity('Coca-Cola', 'Coca-Cola Zero')).toBe(0);
    expect(nameSimilarity('Amul Taaza Toned Milk', 'Amul Gold Full Cream Milk')).toBe(0);
  });
});

describe('scoreMatch', () => {
  const t = (name: string, unit: string, price = 0, inStock?: boolean) => ({ name, unit, price, ...(inStock === undefined ? {} : { inStock }) });

  it.each([
    ['different brand and product', t('Tata Salt', '1 kg', 28), t('Aashirvaad Atta', '1 kg', 60), /different product/],
    ['different brand, only one has product words', t('Amul Butter', '100 g', 58), t('Maggi Noodles', '100 g', 20), /different product/],
    ['different brand, zero on one side', t('Coca-Cola Zero', '750 ml', 40), t('Thums Up', '750 ml', 40), /"zero" variant on one side only/],
    ['soap vs shampoo', t('Dove Soap', '100 g', 60), t('Dove Shampoo', '100 g', 60), /different variant \(soap vs shampoo\)/],
    ['one-sided zero', t('Coca-Cola', '750 ml', 40), t('Coca-Cola Zero', '750 ml', 40), /"zero" variant on one side only/],
    ['conflicting variant', t('Amul Toned Milk', '500 ml'), t('Amul Full Cream Milk', '500 ml'), /different variant \(toned vs fullcream\)/],
    ['weight vs volume (ltr)', t('Tata Salt', '1 kg'), t('Tata Salt', '1 ltr'), /weight vs volume \(1 kg vs 1 L\)/],
    ['two-sided different words', t('English Oven Pav Bread', '400 g'), t('English Oven Milk Bread', '400 g'), /different words \(pav vs milk\)/],
    ['no words in common', t('Atta', '1 kg'), t('Maida', '1 kg'), /different product/],
  ])('rejects: %s', (_label, a, b, reason) => {
    const d = scoreMatch(a, b);
    expect(d).toMatchObject({ rejected: true, score: 0, autoEligible: false });
    expect(d.reasons[0]).toMatch(reason);
  });

  it('a different brand is soft: same type, size and close price may auto-link, said first', () => {
    const d = scoreMatch(t('Tata Salt', '1 kg', 28), t('Aashirvaad Salt', '1 kg', 28));
    expect(d).toMatchObject({ rejected: false, autoEligible: true, brandRelation: 'different' });
    expect(d.reasons[0]).toBe('different brand (Tata → Aashirvaad)');
    expect(d.score).toBeGreaterThanOrEqual(AUTO_MIN);
    // the old hard reject is one option away
    expect(scoreMatch(t('Tata Salt', '1 kg', 28), t('Aashirvaad Salt', '1 kg', 28), { crossBrand: false }))
      .toMatchObject({ rejected: true, reasons: ['different brand (Tata vs Aashirvaad)'] });
  });

  it('across brands, a unit price beyond the tolerance or another size is only a suggestion', () => {
    const r = 1 + CROSS_BRAND_PRICE_TOLERANCE;
    const pricey = scoreMatch(t('Tata Salt', '1 kg', 28), t('Aashirvaad Salt', '1 kg', Math.ceil(28 * r) + 1));
    expect(pricey.autoEligible).toBe(false);
    expect(pricey.reasons[0]).toMatch(/^different brand/);
    expect(pricey.reasons.some(x => x.startsWith('unit price'))).toBe(true);
    const sized = scoreMatch(t('Tata Salt', '1 kg', 28), t('Aashirvaad Salt', '500 g', 15));
    expect(sized.autoEligible).toBe(false);
    expect(sized.reasons.slice(0, 2)).toEqual(['different brand (Tata → Aashirvaad)', 'different size 1 kg vs 500 g, −₹13']);
  });

  it('a brand-only title keeps its kind of product (cola vs orange soda)', () => {
    expect(scoreMatch(t('Coca-Cola', '750 ml', 40), t('Thums Up', '750 ml', 40)).autoEligible).toBe(true);
    expect(scoreMatch(t('Sprite', '750 ml', 40), t('Fanta', '750 ml', 40)).rejected).toBe(true);
  });

  it('a brand on one listing only can auto-link when everything else agrees', () => {
    const d = scoreMatch(t('Paneer', '200 g', 90), t('Milky Mist Paneer', '200 g', 95));
    expect(d).toMatchObject({ autoEligible: true, brandRelation: 'one-sided' });
    expect(d.reasons).toContain('brand only on this listing (Milky Mist)');
  });

  it('an unknown leading word is never taken for a brand: at most a suggestion', () => {
    expect(scoreMatch(t('Nilgiris Paneer', '200 g', 85), t('Amul Paneer', '200 g', 90)).autoEligible).toBe(true); // known brand
    for (const [a, b] of [['Aashirvaad Salt', 'Rock Salt'], ['Amul Milk', 'Soy Milk'], ['Amul Butter', 'Table Butter'], ['Tata Tea', 'Ice Tea']]) {
      const d = scoreMatch(t(a, '1 kg', 100), t(b, '1 kg', 100));
      expect(d.autoEligible).toBe(false);
    }
    const tableButter = scoreMatch(t('Amul Butter', '500 g', 285), t('Table Butter', '500 g', 280));
    expect(tableButter.reasons).toContain('brand may differ (Table vs Amul)');
  });

  it('across brands, a kind-of-product word on one side only rejects', () => {
    expect(scoreMatch(t('Amul Milk', '1 L', 60), t('Milk Powder', '1 L', 60)).reasons[0]).toBe('"powder" on one side only');
    expect(scoreMatch(t('Amul Milk', '1 L', 60), t('Nandini Flavoured Milk', '1 L', 62)).rejected).toBe(true);
    expect(scoreMatch(t('Colgate Toothpaste', '150 g', 120), t('Sensodyne Sensitive Toothpaste', '150 g', 140)).rejected).toBe(true);
    // within one brand the usual extra-word cap still applies
    expect(scoreMatch(t('Amul Milk', '1 L', 60), t('Amul Flavoured Milk', '1 L', 62)).rejected).toBe(false);
  });

  it('explains a different pack size with the price difference', () => {
    const d = scoreMatch(t('Aashirvaad Atta', '500 g', 40), t('Aashirvaad Atta', '1 kg', 52));
    expect(d.rejected).toBe(false);
    expect(d.autoEligible).toBe(false);
    expect(d.reasons[0]).toBe('different size 500 g vs 1 kg, +₹12');
  });

  it('cannot compare pieces with kilograms: suggestion only (B1)', () => {
    const d = scoreMatch(t('Onion', '1 kg', 40), t('Onion', '3 pcs', 40));
    expect(d.autoEligible).toBe(false);
    expect(d.reasons[0]).toBe("can't compare 1 kg with 3 pcs");
    expect(d.score).toBeLessThan(AUTO_MIN);
    expect(d.score).toBeGreaterThanOrEqual(SUGGEST_MIN);
  });

  it('a superset variant is never auto-eligible (B2)', () => {
    const d = scoreMatch(t('Cadbury Dairy Milk', '50 g', 45), t('Cadbury Dairy Milk Silk', '50 g', 45));
    expect(d.autoEligible).toBe(false);
    expect(d.score).toBeLessThan(AUTO_MIN);
    expect(d.reasons).toContain('extra words here: silk');
  });

  it('price per unit matters (B3)', () => {
    const fair = scoreMatch(t('Amul Butter', '100 g', 58), t('Amul Butter', '100 g', 60));
    const steep = scoreMatch(t('Amul Butter', '100 g', 58), t('Amul Butter', '100 g', 150));
    expect(fair.score - steep.score).toBeGreaterThan(0.1);
    expect(steep.autoEligible).toBe(false);
    expect(steep.reasons).toContain('unit price 2.59× higher');
  });

  it('a multipack of the same size is a different listing (B5)', () => {
    const d = scoreMatch(t("Lay's Classic Salted", '52 g', 20), t('Lays Classic Salted', '52 g (Pack of 3)', 60));
    expect(d.autoEligible).toBe(false);
    expect(d.reasons[0]).toBe('different size 52 g vs 3 × 52 g, +₹40');
  });

  it('an unknown pack size ("1 unit") is not a size of one (N7)', () => {
    const d = scoreMatch(t('Amul Butter', '100 g', 58), t('Amul Butter', '1 unit', 58));
    expect(d.parts.size).toBe(0.5);
    expect(d.reasons).toContain('pack size unknown');
  });

  it('flags an out-of-stock twin instead of hiding it', () => {
    const d = scoreMatch(t('Tata Salt', '1 kg', 28), t('Tata Salt', '1 kg', 28, false));
    expect(d.rejected).toBe(false);
    expect(d.autoEligible).toBe(false);
    expect(d.reasons).toContain('out of stock');
  });

  it('a generic title vs a branded one is a suggestion', () => {
    const d = scoreMatch(t('Toned Milk', '500 ml', 27), t('Amul Taaza Toned Milk', '500 ml', 28));
    expect(d.autoEligible).toBe(false);
    expect(d.score).toBeGreaterThanOrEqual(SUGGEST_MIN);
    expect(d.reasons).toContain('brand only on this listing (Amul)');
  });

  it('parent brand mentions agree with the product line', () => {
    expect(scoreMatch(t('Nestle Maggi Masala Noodles', '70 g', 14), t('Maggi Masala Noodles', '70 g', 14)).autoEligible).toBe(true);
    expect(scoreMatch(t('Bournvita', '500 g', 230), t('Cadbury Bournvita Health Drink', '500 g', 228)).autoEligible).toBe(true);
    expect(scoreMatch(t('Kurkure Masala Munch', '90 g'), t("Lay's Magic Masala", '90 g')).rejected).toBe(true);
  });
});

describe('decideMatch', () => {
  const c = (id: string, name: string, unit: string, price: number, inStock?: boolean) => ({ id, name, unit, price, ...(inStock === undefined ? {} : { inStock }) });
  const target = { name: 'Amul Butter', unit: '100 g', price: 58 };

  it('auto: exact twin well ahead of the rest', () => {
    const d = decideMatch(target, [c('a', 'Amul Cheese', '100 g', 60), c('b', 'Amul Pasteurised Butter', '100 g', 60), c('c', 'Amul Butter', '500 g', 285)]);
    expect(d.band).toBe('auto');
    expect(d.best?.candidate.id).toBe('b');
    expect(d.alternatives.map(a => a.candidate.id)).toEqual(['c']);
    expect(d.ranked.map(r => r.candidate.id)).toEqual(['b', 'c', 'a']);
    expect(d.ranked[2].rejected).toBe(true);
  });

  it('suggest: only a different size exists, with the reason', () => {
    const d = decideMatch(target, [c('c', 'Amul Butter', '500 g', 285)]);
    expect(d.band).toBe('suggest');
    expect(d.best?.candidate.id).toBe('c');
    expect(d.reasons[0]).toBe('different size 100 g vs 500 g, +₹227');
  });

  it('suggest: two different listings score alike (B4 ambiguity is used, not ignored)', () => {
    const d = decideMatch({ name: 'Amul Milk', unit: '500 ml', price: 30 }, [
      c('x', 'Amul Taaza Milk', '500 ml', 30),
      c('y', 'Amul Gold Milk', '500 ml', 30),
    ]);
    expect(d.band).toBe('suggest');
    expect(d.reasons.some(r => r.startsWith('close runner-up: '))).toBe(true);
  });

  it('the same listing twice does not block auto; the closer price wins', () => {
    const d = decideMatch(target, [c('x', 'Amul Butter', '100 g', 62), c('y', 'Amul Butter', '100 g', 58)]);
    expect(d.band).toBe('auto');
    expect(d.best?.candidate.id).toBe('y');
  });

  it('prefers an in-stock listing on a tie', () => {
    const d = decideMatch(target, [c('x', 'Amul Butter', '100 g', 58, false), c('y', 'Amul Butter', '100 g', 58)]);
    expect(d.best?.candidate.id).toBe('y');
    expect(d.ranked[1].reasons).toContain('out of stock');
  });

  it('none: nothing similar, or nothing at all', () => {
    expect(decideMatch(target, [c('m', 'Maggi Noodles', '70 g', 14)])).toMatchObject({ band: 'none', best: null });
    expect(decideMatch(target, [])).toMatchObject({ band: 'none', best: null, reasons: ['no similar product'] });
    expect(decideMatch(target, null).ranked).toEqual([]);
  });

  it('alternatives are the top 3 viable, sorted by score', () => {
    const d = decideMatch(target, [
      c('1', 'Amul Butter', '500 g', 285), c('2', 'Amul Butter', '100 g', 58), c('3', 'Amul Butter', '200 g', 110),
      c('4', 'Amul Butter', '1 kg', 560), c('5', 'Amul Butter', '50 g', 30),
    ]);
    const scores = d.alternatives.map(a => a.score);
    expect(d.alternatives).toHaveLength(3);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('thresholds are configurable', () => {
    const d = decideMatch(target, [c('c', 'Amul Butter', '500 g', 285)], { suggestMin: 0.95 });
    expect(d.band).toBe('none');
  });
});

describe('rankCandidates', () => {
  it('orders by score, rejected last, keeping input order on full ties', () => {
    const r = rankCandidates({ name: 'Tata Salt', unit: '1 kg', price: 28 }, [
      { title: 'Aashirvaad Salt', quantity: '1 kg', price: 28 },
      { title: 'Tata Salt', quantity: '500 g', price: 15 },
      { title: 'Tata Salt', quantity: '1 kg', price: 28 },
    ]);
    // Another brand at the same size now outranks the same brand at half the size.
    expect(r.map(x => `${x.candidate.title} ${x.candidate.quantity}`)).toEqual(['Tata Salt 1 kg', 'Aashirvaad Salt 1 kg', 'Tata Salt 500 g']);
  });
  it('a same-brand twin outranks an otherwise equal listing of another brand', () => {
    const r = rankCandidates({ name: 'Tata Salt', unit: '1 kg', price: 28 }, [
      { title: 'Aashirvaad Salt', quantity: '1 kg', price: 28 },
      { title: 'Tata Iodised Salt', quantity: '1 kg', price: 28 },
    ]);
    expect(r.map(x => x.candidate.title)).toEqual(['Tata Iodised Salt', 'Aashirvaad Salt']);
    expect(r[0].score).toBeGreaterThan(r[1].score);
  });
});

describe('decideMatch across brands', () => {
  const target = { name: 'Tata Salt', unit: '1 kg', price: 28 };
  it('auto-links another brand when it is the only twin, saying so', () => {
    const d = decideMatch(target, [{ name: 'Aashirvaad Salt', unit: '1 kg', price: 27 }]);
    expect(d.band).toBe('auto');
    expect(d.reasons[0]).toBe('different brand (Tata → Aashirvaad)');
  });
  it('another brand never blocks the same-brand twin', () => {
    const d = decideMatch(target, [{ name: 'Aashirvaad Salt', unit: '1 kg', price: 28 }, { name: 'Tata Salt', unit: '1 kg', price: 28 }]);
    expect(d.band).toBe('auto');
    expect(d.best?.candidate.name).toBe('Tata Salt');
  });
  it('asks when the same brand is listed in another size', () => {
    const d = decideMatch(target, [{ name: 'Aashirvaad Salt', unit: '1 kg', price: 28 }, { name: 'Tata Salt', unit: '500 g', price: 15 }]);
    expect(d.band).toBe('suggest');
    expect(d.reasons).toContain('same brand listed: Tata Salt 500 g');
  });
  it('can be switched off per call', () => {
    expect(decideMatch(target, [{ name: 'Aashirvaad Salt', unit: '1 kg', price: 28 }], { crossBrand: false }).band).toBe('none');
  });
  it('crossBrand: false keeps the old runner-up rule (brand tiers do not apply)', () => {
    const paneer = [
      { name: 'Amul Fresh Paneer', unit: '200 g', price: 88 },
      { name: 'Paneer', unit: '200 g', price: 90 },
      { name: 'Milky Mist Paneer', unit: '200 g', price: 90, inStock: false },
    ];
    const strict = decideMatch({ name: 'Indian Style Paneer', unit: '200 g' }, paneer, { crossBrand: false });
    expect(strict.band).toBe('suggest');
    expect(strict.reasons.some(r => r.startsWith('close runner-up: '))).toBe(true);
  });
});

describe('isSameProduct never crosses brands', () => {
  it('Tata Salt is not Aashirvaad Salt', () => {
    expect(isSameProduct({ name: 'Tata Salt', unit: '1 kg', price: 28 }, { name: 'Aashirvaad Salt', unit: '1 kg', price: 28 })).toBe(false);
    expect(isSameProduct({ name: 'Coca-Cola', unit: '750 ml' }, { name: 'Thums Up', unit: '750 ml' })).toBe(false);
  });
});

describe('isSameProduct stays strict', () => {
  it('rejects a superset variant and the ltr/kg class conflict', () => {
    expect(isSameProduct({ name: 'Cadbury Dairy Milk', unit: '50 g' }, { name: 'Cadbury Dairy Milk Silk', unit: '50 g' })).toBe(false);
    expect(isSameProduct({ name: 'Tata Salt', unit: '1 kg' }, { name: 'Tata Salt', unit: '1 ltr' })).toBe(false);
    expect(isSameProduct({ name: 'Onion', unit: '1 kg' }, { name: 'Onion', unit: '3 pcs' })).toBe(false);
  });
  it('accepts spelling-only differences at the same size', () => {
    expect(isSameProduct({ name: "Lay's Magic Masala", unit: '50 g' }, { name: 'Lays Magic Masala', unit: '50 g' })).toBe(true);
    expect(isSameProduct({ name: 'Eggs', unit: '12 pcs' }, { name: 'Eggs', unit: '1 dozen' })).toBe(true);
  });
});

describe('buildQueryLadder', () => {
  it('goes from the full title to the head noun', () => {
    expect(buildQueryLadder('Amul Taaza Homogenised Toned Milk 500 ml')).toEqual([
      'Amul Taaza Homogenised Toned Milk 500 ml',
      'amul taaza toned milk',
      'amul taaza toned',
      'milk',
    ]);
  });
  it('keeps multi-word brands together and drops brackets', () => {
    expect(buildQueryLadder("Mother Dairy Classic Curd (Dahi) 400 g")).toEqual([
      'Mother Dairy Classic Curd (Dahi) 400 g',
      'mother dairy curd',
      'curd',
    ]);
  });
  it('drops duplicate and empty rungs', () => {
    expect(buildQueryLadder('Onion')).toEqual(['Onion']);
    expect(buildQueryLadder('Onion (Pyaz)')).toEqual(['Onion (Pyaz)', 'onion']);
    expect(buildQueryLadder('')).toEqual([]);
  });
});

describe('parseTitle: brackets', () => {
  it('drops a bracket that only translates the product', () => {
    expect(parseTitle('Green Chilli (Menasinakayi)')).toEqual({ tokens: ['green', 'chili'], aliases: [], alts: [] });
    expect(parseTitle('Fortune Unpolished Arhar Dal/ Toor Dal (Togari Bele)')).toEqual({ tokens: ['fortune', 'unpolished', 'toor', 'dal'], aliases: [], alts: [] });
    expect(parseTitle('Aashirvaad Superior MP Chakki Atta - l kg (Godihittu)').tokens).toEqual(['aashirvaad', 'superior', 'mp', 'atta']);
  });
  it('keeps the unmatched words of a translating bracket as help-only aliases', () => {
    expect(parseTitle('Lemon (Nimbe Hannu)')).toEqual({ tokens: ['lemon'], aliases: ['fruit'], alts: [] });
  });
  it('keeps a bracket that adds words, and variant words wherever they are', () => {
    expect(parseTitle('Cadbury Dairy Milk (Fruit & Nut)').tokens).toEqual(['cadbury', 'dairymilk', 'fruit', 'nut']);
    expect(parseTitle('JK Red Chilli Powder (Hot) (Kharada Pudi)').tokens).toEqual(['jk', 'red', 'chili', 'powder', 'hot']);
    expect(parseTitle('Coca-Cola (Zero Sugar)').tokens).toEqual(['cocacola', 'zero']);
    expect(parseTitle('Onion (Small Onion)').tokens).toEqual(['onion', 'small']);
  });
});

describe('parseTitle: slash pairs', () => {
  it('records the two names on either side of a slash', () => {
    expect(parseTitle('Sabja/ Basil Seeds')).toEqual({ tokens: ['sabja', 'basil', 'seed'], aliases: [], alts: [[['sabja'], ['basil', 'seed']]] });
  });
  it('needs no pair when one side repeats the other through synonyms', () => {
    expect(parseTitle('Hamdard Khaalis Cumin Seeds / Jeera Seeds').alts).toEqual([]);
    expect(parseTitle('Aashirvaad Haldi/ Turmeric Powder').alts).toEqual([]);
  });
  it('never takes the brand (known, or the leading word) into a pair', () => {
    expect(parseTitle('Catch Sabja/ Basil Seeds').alts).toEqual([[['sabja'], ['basil', 'seed']]]);
    expect(parseTitle('Zingo Sabja/ Basil Seeds').alts).toEqual([[['sabja'], ['basil', 'seed']]]);
    expect(decideMatch({ name: 'Zingo Sabja/ Basil Seeds', unit: '100 g' }, [{ name: 'Basil Seeds', unit: '100 g' }]).band).not.toBe('auto');
  });
});

describe('decideMatch: glosses and slash pairs', () => {
  const t = { name: 'Sabja/ Basil Seeds', unit: '100 g', price: 60 };
  it('lets either side of a slash match', () => {
    expect(decideMatch(t, [{ name: 'Basil Seeds', unit: '100 g', price: 58 }]).band).toBe('auto');
    expect(decideMatch(t, [{ name: 'Sabja Seeds', unit: '100 g', price: 58 }]).band).toBe('auto');
    expect(decideMatch(t, [{ name: 'Chia Seeds', unit: '100 g', price: 90 }]).band).toBe('none');
  });
  it('uses gloss words for variant conflicts', () => {
    // "Kothambari Soppu" = coriander leaves: not the powder.
    const d = decideMatch({ name: 'Coriander (Kothambari Soppu)', unit: '100 g' }, [{ name: 'Coriander Powder', unit: '100 g' }]);
    expect(d.band).toBe('none');
    expect(d.ranked[0].reasons[0]).toBe('different variant (leaf vs powder)');
  });
  it('lets gloss words confirm a match the other title spells out', () => {
    expect(decideMatch({ name: 'Lemon (Nimbe Hannu)', unit: '4 pcs' }, [{ name: 'Lemon Fruit', unit: '4 pcs' }]).band).toBe('auto');
  });
});

describe('isSameProduct: descriptor phrases count there', () => {
  it('keeps "Leaf Tea" / "Powder" / "Fruit Drink" listings apart, unlike cross-store scoring', () => {
    const pairs: [string, string, string][] = [
      ['Tata Tea Gold', 'Tata Tea Gold Leaf Tea', '500 g'],
      ['Bru Instant Coffee', 'Bru Instant Coffee Powder', '100 g'],
      ['Frooti Mango Drink', 'Frooti Mango Fruit Drink', '200 ml'],
    ];
    for (const [a, b, unit] of pairs) {
      expect(isSameProduct({ name: a, unit }, { name: b, unit })).toBe(false);
      expect(decideMatch({ name: a, unit }, [{ name: b, unit }]).band).toBe('auto');
    }
  });
  it('still accepts a pure translation', () => {
    expect(isSameProduct({ name: 'Onion', unit: '1 kg' }, { name: 'Onion (Pyaz)', unit: '1 kg' })).toBe(true);
  });
});

describe('buildQueryLadder: real titles', () => {
  it('drops the size typo and words a slash repeats', () => {
    expect(buildQueryLadder('Aashirvaad Superior MP Chakki Atta - l kg (Godihittu)')).toEqual([
      'Aashirvaad Superior MP Chakki Atta - l kg (Godihittu)', 'aashirvaad mp chakki atta', 'aashirvaad mp chakki', 'atta',
    ]);
    expect(buildQueryLadder('Fortune Unpolished Arhar Dal/ Toor Dal (Togari Bele)')).toEqual([
      'Fortune Unpolished Arhar Dal/ Toor Dal (Togari Bele)', 'fortune arhar dal', 'dal',
    ]);
  });
});
