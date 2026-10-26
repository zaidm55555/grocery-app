// Labelled fixture set for the cross-store matcher: every pair goes through
// decideMatch(target, [candidate]) and is checked against its expected band.
import { decideMatch, MatchBand } from '../matcher';
import { MATCH_PAIRS, MatchPair } from './fixtures/matchPairs';

const run = (pr: MatchPair): MatchBand => decideMatch(pr.a, [pr.b]).band;
const results = MATCH_PAIRS.map(pr => ({ pr, band: run(pr) }));
const of = (label: MatchPair['expect']) => results.filter(r => r.pr.expect === label);
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 100);

const mustMatch = results.filter(r => r.pr.expect !== 'none');
const autoPredicted = results.filter(r => r.band === 'auto');
const metrics = {
  pairs: results.length,
  autoPrecision: pct(autoPredicted.filter(r => r.pr.expect === 'auto').length, autoPredicted.length),
  autoRecall: pct(of('auto').filter(r => r.band === 'auto').length, of('auto').length),
  surfacedRecall: pct(mustMatch.filter(r => r.band !== 'none').length, mustMatch.length),
  suggestExact: pct(of('suggest').filter(r => r.band === 'suggest').length, of('suggest').length),
  noneExact: pct(of('none').filter(r => r.band === 'none').length, of('none').length),
  noneShownAsSuggest: of('none').filter(r => r.band === 'suggest').length,
  bandAgreement: pct(results.filter(r => r.band === r.pr.expect).length, results.length),
};

// Bars: auto must be 100% precise; recall bars leave room for wording we can't know.
const AUTO_RECALL_BAR = 90;
const SURFACED_RECALL_BAR = 95;

afterAll(() => {
  console.log(
    `matcher fixtures: ${metrics.pairs} pairs (${of('auto').length} auto / ${of('suggest').length} suggest / ${of('none').length} none)\n` +
    `  auto precision ${metrics.autoPrecision}% | auto recall ${metrics.autoRecall}% | surfaced recall (auto+suggest) ${metrics.surfacedRecall}%\n` +
    `  suggest exact ${metrics.suggestExact}% | none exact ${metrics.noneExact}% (${metrics.noneShownAsSuggest} different products shown as suggestions) | band agreement ${metrics.bandAgreement}%`,
  );
});

describe('matcher fixture set', () => {
  it('is a broad labelled set covering every defect class', () => {
    expect(results.length).toBeGreaterThanOrEqual(120);
    const tags = new Set(MATCH_PAIRS.map(p => p.tag));
    ['N1', 'N3', 'N6', 'N7', 'N8', 'N9', 'B1', 'B2', 'B3', 'B5', 'brand', 'variant', 'class', 'stock'].forEach(t => expect(tags).toContain(t));
    (['auto', 'suggest', 'none'] as const).forEach(l => expect(of(l).length).toBeGreaterThan(20));
  });

  it.each(results.filter(r => r.pr.expect !== 'auto').map(r => [r.pr.a.name, r.pr.a.unit, r.pr.b.name, r.pr.b.unit, r.band] as const))(
    'never auto-links %s %s ~ %s %s (got %s)',
    (_a, _au, _b, _bu, band) => {
      expect(band).not.toBe('auto');
    },
  );

  it('auto band is 100% precise', () => {
    expect(metrics.autoPrecision).toBe(100);
  });

  it(`auto-links at least ${AUTO_RECALL_BAR}% of same-product pairs`, () => {
    expect(metrics.autoRecall).toBeGreaterThanOrEqual(AUTO_RECALL_BAR);
  });

  it(`surfaces (auto or suggest) at least ${SURFACED_RECALL_BAR}% of pairs that should match`, () => {
    expect(metrics.surfacedRecall).toBeGreaterThanOrEqual(SURFACED_RECALL_BAR);
  });

  it('puts the suggest-labelled pairs in the suggest band', () => {
    expect(of('suggest').filter(r => r.band !== 'suggest').map(r => `${r.pr.a.name} ~ ${r.pr.b.name}: ${r.band}`)).toEqual([]);
  });
});
