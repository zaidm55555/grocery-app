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

const setup = (f: MatchFlowState) => {
  const h = { onChoose: jest.fn(), onRetry: jest.fn(), onSkip: jest.fn(), onConfirm: jest.fn() };
  return { ...render(<MatchModal flow={f} {...h} />), ...h };
};

describe('MatchModal: searching step', () => {
  it('shows progress per app and no footer', () => {
    const { getByText, queryByText } = setup(flow({ step: 'searching', results: { t1: { swiggy: { status: 'pending', candidates: [], best: null, score: null } } } }));
    expect(getByText('Matching on other apps…')).toBeTruthy();
    expect(getByText('Searching Instamart…')).toBeTruthy();
    expect(queryByText('Skip')).toBeNull();
    expect(queryByText(/^Confirm/)).toBeNull();
  });

  it('shows a retry control for a failed cell and calls onRetry', () => {
    const { getByText, onRetry } = setup(flow({ step: 'searching', results: { t1: { swiggy: { status: 'error', candidates: [], best: null, score: null } } } }));
    fireEvent.press(getByText('Retry'));
    expect(onRetry).toHaveBeenCalledWith('t1', 'swiggy');
  });

  it('shows "no match" for an empty cell', () => {
    const { getByText } = setup(flow({ step: 'searching', results: { t1: { swiggy: { status: 'empty', candidates: [], best: null, score: null } } } }));
    expect(getByText('no match')).toBeTruthy();
  });

  it('uses a plural subtitle for several items', () => {
    const { getByText } = setup(flow({ step: 'searching', targets: [target, { ...target, id: 't2', name: 'Milk' }], results: {} }));
    expect(getByText('2 items searching in the background…')).toBeTruthy();
  });
});

describe('MatchModal: confirm step', () => {
  it('shows the auto-matched candidate and a confirm button counting it', () => {
    const { getByText, onConfirm } = setup(flow());
    expect(getByText('Tata Salt Best')).toBeTruthy();
    expect(getByText('auto-matched')).toBeTruthy();
    fireEvent.press(getByText('Confirm · 1 match'));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('Skip (footer) and the close button both call onSkip', () => {
    const { getByText, onSkip } = setup(flow());
    fireEvent.press(getByText('Skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('pluralises the confirm count and counts every platform/target match', () => {
    const f = flow({
      targets: [target, { ...target, id: 't2', name: 'Milk' }],
      results: { t1: { swiggy: okCell() }, t2: { swiggy: okCell(swiggyProd('s2', 'Amul Milk')) } },
    });
    expect(setup(f).getByText('Confirm · 2 matches')).toBeTruthy();
  });

  it('excludes skipped apps from the count; Confirm is disabled at zero', () => {
    const f = flow({ chosen: { t1: { swiggy: 'skip' } } });
    const { getByText, onConfirm } = setup(f);
    expect(getByText('Confirm · 0 matches')).toBeTruthy();
    fireEvent.press(getByText('Confirm · 0 matches'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('counts an explicit pick even when there was no auto best', () => {
    const picked = { product: swiggyProd('s-x', 'Manual'), score: 0.4 };
    const f = flow({
      results: { t1: { swiggy: { status: 'empty', candidates: [picked.product], best: null, score: null } } },
      chosen: { t1: { swiggy: picked } },
    });
    expect(setup(f).getByText('Confirm · 1 match')).toBeTruthy();
  });

  it('lets the user expand other matches, choose one, and shows the chosen score', () => {
    const alt = swiggyProd('s-alt', 'Tata Salt Alt', 31);
    const f = flow({ results: { t1: { swiggy: okCell(swiggyProd('s-best', 'Tata Salt Best'), [alt]) } } });
    const { getByText, queryByText, onChoose } = setup(f);
    expect(queryByText('Tata Salt Alt')).toBeNull();
    fireEvent.press(getByText(/Other matches · 1/));
    fireEvent.press(getByText('Tata Salt Alt'));
    expect(onChoose).toHaveBeenCalledWith('t1', 'swiggy', expect.objectContaining({ product: alt }));
  });

  it('skipping an app calls onChoose with "skip"', () => {
    const { getByText, onChoose } = setup(flow());
    fireEvent.press(getByText(/Other matches/));
    fireEvent.press(getByText(/None of these match/));
    expect(onChoose).toHaveBeenCalledWith('t1', 'swiggy', 'skip');
  });

  it('shows the skipped note for a skipped app', () => {
    const { getByText } = setup(flow({ chosen: { t1: { swiggy: 'skip' } } }));
    expect(getByText(/Skipped — this app won’t be priced for this item\./)).toBeTruthy();
  });

  it('shows the chosen candidate\'s score in the badge', () => {
    const picked = { product: swiggyProd('s-best', 'Tata Salt Best'), score: 0.8 };
    expect(setup(flow({ chosen: { t1: { swiggy: picked } } })).getByText('auto-matched · 80%')).toBeTruthy();
  });

  it('empty cell: shows guidance, lets the user pick manually or skip', () => {
    const cand = swiggyProd('s-c', 'Close Candidate');
    const f = flow({ results: { t1: { swiggy: { status: 'empty', candidates: [cand], best: null, score: null } } } });
    const { getByText, queryByText, onChoose } = setup(f);
    expect(getByText('no close match')).toBeTruthy();
    expect(getByText('No close match found on Instamart.')).toBeTruthy();
    expect(queryByText('Close Candidate')).toBeNull();
    fireEvent.press(getByText('Pick manually'));
    fireEvent.press(getByText('Close Candidate'));
    expect(onChoose).toHaveBeenCalledWith('t1', 'swiggy', expect.objectContaining({ product: cand }));
    fireEvent.press(getByText(/None of these match/));
    expect(onChoose).toHaveBeenCalledWith('t1', 'swiggy', 'skip');
  });

  it('error cell: shows the message and retries', () => {
    const f = flow({ results: { t1: { swiggy: { status: 'error', error: 'Search failed (500).', candidates: [], best: null, score: null } } } });
    const { getByText, onRetry } = setup(f);
    expect(getByText('error')).toBeTruthy();
    expect(getByText(/Search failed \(500\)\./)).toBeTruthy();
    fireEvent.press(getByText('Retry'));
    expect(onRetry).toHaveBeenCalledWith('t1', 'swiggy');
  });

  it('error cell without a message falls back to a generic one', () => {
    const f = flow({ results: { t1: { swiggy: { status: 'error', candidates: [], best: null, score: null } } } });
    expect(setup(f).getByText(/Search failed\./)).toBeTruthy();
  });
});
