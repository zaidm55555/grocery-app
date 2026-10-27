import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import MatchModal, { MatchFlowState, MatchCell } from '../MatchModal';
import { product } from '../../services/__tests__/fixtures';

const target = { id: 't1', name: 'Tata Salt', unit: '1 kg', price: 28, image: '' };
const swiggyProd = (id: string, title: string, price = 30) => product({ id, title, price, platform: 'swiggy', quantity: '1 kg' });
const okCell = (best = swiggyProd('s-best', 'Tata Salt Best'), extra: any[] = []): MatchCell => ({
  status: 'ok', best, score: 0.92, candidates: [best, ...extra],
});

const flow = (over: Partial<MatchFlowState> = {}): MatchFlowState => ({
  step: 'candidates',
  targets: [target],
  sourcePlatform: 'blinkit',
  otherPlatforms: ['swiggy'],
  results: { t1: { swiggy: okCell() } },
  chosen: {},
  ...over,
});

const setup = async (f: MatchFlowState) => {
  const h = { onChoose: jest.fn(), onRetry: jest.fn(), onSkip: jest.fn(), onConfirm: jest.fn() };
  return { ...await render(<MatchModal flow={f} {...h} />), ...h };
};

describe('MatchModal: searching step', () => {
  it('shows progress per app and no footer', async () => {
    const { getByText, queryByText } = await setup(flow({ step: 'searching', results: { t1: { swiggy: { status: 'pending', candidates: [], best: null, score: null } } } }));
    expect(getByText('Matching on other apps…')).toBeTruthy();
    expect(getByText('Searching Instamart…')).toBeTruthy();
    expect(queryByText('Skip')).toBeNull();
    expect(queryByText(/^Confirm/)).toBeNull();
  });

  it('shows a retry control for a failed cell and calls onRetry', async () => {
    const { getByText, onRetry } = await setup(flow({ step: 'searching', results: { t1: { swiggy: { status: 'error', candidates: [], best: null, score: null } } } }));
    await fireEvent.press(getByText('Retry'));
    expect(onRetry).toHaveBeenCalledWith('t1', 'swiggy');
  });

  it('shows "no match" for an empty cell', async () => {
    const { getByText } = await setup(flow({ step: 'searching', results: { t1: { swiggy: { status: 'empty', candidates: [], best: null, score: null } } } }));
    expect(getByText('no match')).toBeTruthy();
  });

  it('uses a plural subtitle for several items', async () => {
    const { getByText } = await setup(flow({ step: 'searching', targets: [target, { ...target, id: 't2', name: 'Milk' }], results: {} }));
    expect(getByText('2 items searching in the background…')).toBeTruthy();
  });
});

describe('MatchModal: confirm step', () => {
  it('shows the auto-matched candidate and a confirm button counting it', async () => {
    const { getByText, onConfirm } = await setup(flow());
    expect(getByText('Tata Salt Best')).toBeTruthy();
    expect(getByText('auto-matched')).toBeTruthy();
    await fireEvent.press(getByText('Confirm · 1 match'));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('an auto-match of another brand says so on the badge and the row', async () => {
    const best = swiggyProd('s-a', 'Aashirvaad Salt', 28);
    const cell: MatchCell = { ...okCell(best), ranked: [{ product: best, score: 0.9, reasons: ['different brand (Tata → Aashirvaad)'] }] };
    const { getByText } = await setup(flow({ results: { t1: { swiggy: cell } } }));
    expect(getByText(/other brand/)).toBeTruthy();
    expect(getByText('different brand (Tata → Aashirvaad)')).toBeTruthy();
  });

  it('Skip (footer) and the close button both call onSkip', async () => {
    const { getByText, onSkip } = await setup(flow());
    await fireEvent.press(getByText('Skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('pluralises the confirm count and counts every platform/target match', async () => {
    const f = flow({
      targets: [target, { ...target, id: 't2', name: 'Milk' }],
      results: { t1: { swiggy: okCell() }, t2: { swiggy: okCell(swiggyProd('s2', 'Amul Milk')) } },
    });
    expect((await setup(f)).getByText('Confirm · 2 matches')).toBeTruthy();
  });

  it('excludes skipped apps from the count; Confirm is disabled at zero', async () => {
    const f = flow({ chosen: { t1: { swiggy: 'skip' } } });
    const { getByText, onConfirm } = await setup(f);
    expect(getByText('Confirm · 0 matches')).toBeTruthy();
    await fireEvent.press(getByText('Confirm · 0 matches'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('counts an explicit pick even when there was no auto best', async () => {
    const picked = { product: swiggyProd('s-x', 'Manual'), score: 0.4 };
    const f = flow({
      results: { t1: { swiggy: { status: 'empty', candidates: [picked.product], best: null, score: null } } },
      chosen: { t1: { swiggy: picked } },
    });
    expect((await setup(f)).getByText('Confirm · 1 match')).toBeTruthy();
  });

  it('lets the user expand other matches, choose one, and shows the chosen score', async () => {
    const alt = swiggyProd('s-alt', 'Tata Salt Alt', 31);
    const f = flow({ results: { t1: { swiggy: okCell(swiggyProd('s-best', 'Tata Salt Best'), [alt]) } } });
    const { getByText, queryByText, onChoose } = await setup(f);
    expect(queryByText('Tata Salt Alt')).toBeNull();
    await fireEvent.press(getByText(/Other matches · 1/));
    await fireEvent.press(getByText('Tata Salt Alt'));
    expect(onChoose).toHaveBeenCalledWith('t1', 'swiggy', expect.objectContaining({ product: alt }));
  });

  it('skipping an app calls onChoose with "skip"', async () => {
    const { getByText, onChoose } = await setup(flow());
    await fireEvent.press(getByText(/Other matches/));
    await fireEvent.press(getByText(/None of these match/));
    expect(onChoose).toHaveBeenCalledWith('t1', 'swiggy', 'skip');
  });

  it('shows the skipped note for a skipped app', async () => {
    const { getByText } = await setup(flow({ chosen: { t1: { swiggy: 'skip' } } }));
    expect(getByText(/Skipped — this app won’t be priced for this item\./)).toBeTruthy();
  });

  it('shows the chosen candidate\'s score in the badge', async () => {
    const picked = { product: swiggyProd('s-best', 'Tata Salt Best'), score: 0.8 };
    expect((await setup(flow({ chosen: { t1: { swiggy: picked } } }))).getByText('auto-matched · 80%')).toBeTruthy();
  });

  it('empty cell: shows guidance, lets the user pick manually or skip', async () => {
    const cand = swiggyProd('s-c', 'Close Candidate');
    const f = flow({ results: { t1: { swiggy: { status: 'empty', candidates: [cand], best: null, score: null } } } });
    const { getByText, queryByText, onChoose } = await setup(f);
    expect(getByText('no close match')).toBeTruthy();
    expect(getByText('No close match found on Instamart.')).toBeTruthy();
    expect(queryByText('Close Candidate')).toBeNull();
    await fireEvent.press(getByText('Pick manually'));
    await fireEvent.press(getByText('Close Candidate'));
    expect(onChoose).toHaveBeenCalledWith('t1', 'swiggy', expect.objectContaining({ product: cand }));
    await fireEvent.press(getByText(/None of these match/));
    expect(onChoose).toHaveBeenCalledWith('t1', 'swiggy', 'skip');
  });

  it('error cell: shows the message and retries', async () => {
    const f = flow({ results: { t1: { swiggy: { status: 'error', error: 'Search failed (500).', candidates: [], best: null, score: null } } } });
    const { getByText, onRetry } = await setup(f);
    expect(getByText('error')).toBeTruthy();
    expect(getByText(/Search failed \(500\)\./)).toBeTruthy();
    await fireEvent.press(getByText('Retry'));
    expect(onRetry).toHaveBeenCalledWith('t1', 'swiggy');
  });

  it('error cell without a message falls back to a generic one', async () => {
    const f = flow({ results: { t1: { swiggy: { status: 'error', candidates: [], best: null, score: null } } } });
    expect((await setup(f)).getByText(/Search failed\./)).toBeTruthy();
  });
});

describe('MatchModal: ranking and suggestions', () => {
  const sp = (id: string, title: string, quantity: string, price: number) => product({ id, title, quantity, price, platform: 'swiggy' });

  it('lists candidates by match score, not search order', async () => {
    const weak = sp('w', 'Aashirvaad Salt', '1 kg', 28);
    const mid = sp('m', 'Tata Salt', '500 g', 15);
    const strong = sp('s', 'Tata Iodised Salt', '1 kg', 28);
    const f = flow({ results: { t1: { swiggy: { status: 'empty', candidates: [weak, mid, strong], best: null, score: null } } } });
    const { getByText, getAllByText } = await setup(f);
    await fireEvent.press(getByText('Pick manually'));
    const titles = getAllByText(/Salt$/).map(n => n.props.children).slice(1); // [0] is the target header
    // Another brand at the same size ranks above the same brand at half the size.
    expect(titles).toEqual(['Tata Iodised Salt', 'Aashirvaad Salt', 'Tata Salt']);
    expect(getByText(/different size 1 kg vs 500 g/)).toBeTruthy();
    expect(getByText(/different brand \(Tata → Aashirvaad\)/)).toBeTruthy();
  });

  it('uses the ranking stored by the search when present', async () => {
    const a = sp('a', 'First Listing', '1 kg', 10);
    const b = sp('b', 'Second Listing', '1 kg', 10);
    const cell: MatchCell = {
      status: 'empty', candidates: [a, b], best: null, score: null,
      ranked: [{ product: b, score: 0.7, reasons: ['pack size unknown'] }, { product: a, score: 0.2, reasons: [] }],
    };
    const { getByText, getAllByText } = await setup(flow({ results: { t1: { swiggy: cell } } }));
    await fireEvent.press(getByText('Pick manually'));
    expect(getAllByText(/Listing$/).map(n => n.props.children)).toEqual(['Second Listing', 'First Listing']);
    expect(getByText('70%')).toBeTruthy();
    expect(getByText('pack size unknown')).toBeTruthy();
  });

  it('shows more than 8 candidates on request', async () => {
    const many = Array.from({ length: 11 }, (_, i) => sp(`c${i}`, `Candidate ${i}`, '1 kg', 10));
    const f = flow({ results: { t1: { swiggy: { status: 'empty', candidates: many, best: null, score: null } } } });
    const { getByText, queryAllByText } = await setup(f);
    await fireEvent.press(getByText('Pick manually'));
    expect(queryAllByText(/^Candidate \d+$/)).toHaveLength(8);
    await fireEvent.press(getByText('Show 3 more'));
    expect(queryAllByText(/^Candidate \d+$/)).toHaveLength(11);
  });

  it('a suggestion is shown with its reasons but needs a tap before it counts', async () => {
    const litre = sp('s-l', 'Tata Salt Large', '2 kg', 55);
    const cell: MatchCell = {
      status: 'suggest', candidates: [litre], best: null, score: 0.72,
      suggestion: { product: litre, score: 0.72, reasons: ['different size 1 kg vs 2 kg, +₹27'] },
      ranked: [{ product: litre, score: 0.72, reasons: ['different size 1 kg vs 2 kg, +₹27'] }],
    };
    const { getByText, onChoose } = await setup(flow({ results: { t1: { swiggy: cell } } }));
    expect(getByText('check match')).toBeTruthy();
    expect(getByText('different size 1 kg vs 2 kg, +₹27')).toBeTruthy();
    expect(getByText('Confirm · 0 matches')).toBeTruthy();
    await fireEvent.press(getByText('Tata Salt Large'));
    expect(onChoose).toHaveBeenCalledWith('t1', 'swiggy', { product: litre, score: 0.72 });
  });

  it('a picked suggestion counts and says so', async () => {
    const litre = sp('s-l', 'Tata Salt Large', '2 kg', 55);
    const cell: MatchCell = { status: 'suggest', candidates: [litre], best: null, score: 0.72, suggestion: { product: litre, score: 0.72 } };
    const f = flow({ results: { t1: { swiggy: cell } }, chosen: { t1: { swiggy: { product: litre, score: 0.72 } } } });
    const { getByText } = await setup(f);
    expect(getByText('picked · 72%')).toBeTruthy();
    expect(getByText('Confirm · 1 match')).toBeTruthy();
  });

  it('marks a suggestion cell as "check" while searching', async () => {
    const f = flow({ step: 'searching', results: { t1: { swiggy: { status: 'suggest', candidates: [], best: null, score: 0.7 } } } });
    expect((await setup(f)).getByText('check')).toBeTruthy();
  });

  it('keeps the user\'s pick on top instead of hiding it among the alternatives', async () => {
    const alt = swiggyProd('s-alt', 'Tata Salt Alt', 31);
    const f = flow({
      results: { t1: { swiggy: okCell(swiggyProd('s-best', 'Tata Salt Best'), [alt]) } },
      chosen: { t1: { swiggy: { product: alt, score: 0.9 } } },
    });
    const { getByText } = await setup(f);
    expect(getByText('Tata Salt Alt')).toBeTruthy();
    await fireEvent.press(getByText(/Other matches · 1/));
    expect(getByText('Tata Salt Best')).toBeTruthy();
  });
});
