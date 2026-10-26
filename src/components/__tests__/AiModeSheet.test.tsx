import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import AiModeSheet from '../AiModeSheet';
import { aiKey } from '../../services/aiKey';
import { buildAiBasket, AiBasketResult } from '../../services/aiMode';
import { GroqError } from '../../services/groq';
import type { CartLine } from '../../services/lists';
import { product } from '../../services/__tests__/fixtures';

jest.mock('../../services/aiKey', () => ({ aiKey: { get: jest.fn() } }));
jest.mock('../../services/aiMode', () => ({ buildAiBasket: jest.fn(), searchAllStores: jest.fn() }));

const mockGet = aiKey.get as jest.Mock;
const mockBuild = buildAiBasket as jest.Mock;

const milk = product({ id: 'blinkit-milk', title: 'Amul Taaza Milk', quantity: '500 ml', price: 27, platform: 'blinkit' });
const eggs = product({ id: 'swiggy-eggs', title: 'Farm Eggs 6 pcs', quantity: '6 pcs', price: 48, platform: 'swiggy' });
const RESULT: AiBasketResult = {
  requested: [
    { name: 'Milk', query: 'milk', amount: '1 litre' },
    { name: 'Eggs', query: 'eggs', amount: '24 pieces' },
    { name: 'Saffron', query: 'saffron', amount: '' },
  ],
  picks: [
    { index: 0, item: { name: 'Milk', query: 'milk', amount: '1 litre' }, product: milk, units: 2, reason: '2 x 500 ml' },
    { index: 1, item: { name: 'Eggs', query: 'eggs', amount: '24 pieces' }, product: eggs, units: 4, reason: '4 x 6 eggs' },
  ],
  unmatched: [{ index: 2, item: { name: 'Saffron', query: 'saffron', amount: '' }, reason: 'No results on Blinkit or Instamart' }],
};

const setup = async (props: Partial<React.ComponentProps<typeof AiModeSheet>> = {}, initial: CartLine[] = []) => {
  let cart = initial;
  const onCommitCart = jest.fn(async (next: CartLine[]) => { cart = next; });
  const onClose = jest.fn();
  const onViewBasket = jest.fn();
  const utils = await render(
    <AiModeSheet
      visible
      onClose={onClose}
      getCart={() => cart}
      onCommitCart={onCommitCart}
      onViewBasket={onViewBasket}
      {...props}
    />
  );
  return { ...utils, onCommitCart, onClose, onViewBasket, cart: () => cart };
};

const lines = (cart: CartLine[]) => cart.map(l => [l.product.id, l.quantity]);

const runRequest = async (u: Awaited<ReturnType<typeof setup>>, text = 'milk and eggs') => {
  await fireEvent.changeText(u.getByLabelText('What do you need?'), text);
  await act(async () => { await fireEvent.press(u.getByText('Build my basket')); });
};

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue('gsk_testkey1234567890abcdef');
  mockBuild.mockReset().mockResolvedValue(RESULT);
});

describe('AiModeSheet', () => {
  it('says the Groq key is not configured when the env var is unset, without a Profile link', async () => {
    mockGet.mockResolvedValue(null);
    const u = await setup();
    expect(await u.findByText('Groq API key not configured')).toBeTruthy();
    expect(u.getByText(/EXPO_PUBLIC_GROQ_API_KEY in \.env\.local/)).toBeTruthy();
    expect(u.queryByText(/Profile/)).toBeNull();
  });

  it('shows why it cannot run and does not run', async () => {
    const u = await setup({ blockedReason: 'Set your delivery location in Profile first.' });
    expect(await u.findByText('Set your delivery location in Profile first.')).toBeTruthy();
    await runRequest(u);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('fills in the example request', async () => {
    const u = await setup();
    await fireEvent.press(await u.findByText(/^Try:/));
    expect(u.getByLabelText('What do you need?').props.value).toMatch(/dal tadka/);
  });

  it('adds the picks to the basket and shows a review with what was not added', async () => {
    const u = await setup({}, [{ product: product({ id: 'blinkit-old', title: 'Bread' }), quantity: 1 }]);
    await runRequest(u, 'a litre of milk, 2 dozen eggs, saffron');

    expect(mockBuild).toHaveBeenCalledWith('a litre of milk, 2 dozen eggs, saffron', expect.objectContaining({ apiKey: 'gsk_testkey1234567890abcdef' }));
    expect(lines(u.cart())).toEqual([['blinkit-old', 1], ['blinkit-milk', 2], ['swiggy-eggs', 4]]);
    expect(await u.findByText('Added 2 items to your basket')).toBeTruthy();
    expect(u.getByText('Amul Taaza Milk')).toBeTruthy();
    expect(u.getByText('Farm Eggs 6 pcs')).toBeTruthy();
    expect(u.getByText('Not added (1)')).toBeTruthy();
    expect(u.getByText('No results on Blinkit or Instamart')).toBeTruthy();
  });

  it('removes a single item, can add it back, and undoes everything', async () => {
    const u = await setup({}, [{ product: product({ id: 'blinkit-old', title: 'Bread' }), quantity: 1 }]);
    await runRequest(u);
    await act(async () => { await fireEvent.press(u.getByLabelText('Remove Amul Taaza Milk')); });
    expect(lines(u.cart())).toEqual([['blinkit-old', 1], ['swiggy-eggs', 4]]);
    expect(u.getByText('Added 1 item to your basket')).toBeTruthy();

    await act(async () => { await fireEvent.press(u.getByLabelText('Add back Amul Taaza Milk')); });
    expect(lines(u.cart())).toEqual([['blinkit-old', 1], ['swiggy-eggs', 4], ['blinkit-milk', 2]]);

    await act(async () => { await fireEvent.press(u.getByText('Undo all')); });
    expect(lines(u.cart())).toEqual([['blinkit-old', 1]]);
    expect(u.getByText('Nothing added to your basket')).toBeTruthy();
  });

  it('does not touch the basket when nothing matched', async () => {
    mockBuild.mockResolvedValue({ ...RESULT, picks: [] });
    const u = await setup();
    await runRequest(u);
    expect(u.onCommitCart).not.toHaveBeenCalled();
    expect(await u.findByText('Nothing added to your basket')).toBeTruthy();
  });

  it('opens the basket from the review', async () => {
    const u = await setup();
    await runRequest(u);
    await fireEvent.press(await u.findByText('View basket'));
    expect(u.onClose).toHaveBeenCalled();
    expect(u.onViewBasket).toHaveBeenCalled();
  });

  it('shows an auth error and lets the user retry', async () => {
    mockBuild.mockRejectedValue(new GroqError('Groq rejected the API key. Check EXPO_PUBLIC_GROQ_API_KEY.', 'auth', 401));
    const u = await setup();
    await runRequest(u);
    expect(await u.findByText('Groq rejected the API key. Check EXPO_PUBLIC_GROQ_API_KEY.')).toBeTruthy();
    expect(u.queryByText('Open Profile')).toBeNull();
    await fireEvent.press(u.getByText('Try again'));
    expect(u.getByText('Build my basket')).toBeTruthy();
    expect(u.onCommitCart).not.toHaveBeenCalled();
  });

  it('cancelling mid-run leaves the basket alone', async () => {
    let finish: (r: AiBasketResult) => void = () => {};
    mockBuild.mockImplementation(() => new Promise(res => { finish = res; }));
    const u = await setup();
    await fireEvent.changeText(u.getByLabelText('What do you need?'), 'milk and eggs');
    // RNTL 14's fireEvent awaits the handler's promise, which here only settles once the build finishes.
    const building = fireEvent.press(u.getByText('Build my basket'));
    expect(await u.findByText('Reading your request…')).toBeTruthy();
    await fireEvent.press(u.getByText('Cancel'));
    await act(async () => { finish(RESULT); });
    await building;
    expect(u.onCommitCart).not.toHaveBeenCalled();
    await waitFor(() => expect(u.getByText('Build my basket')).toBeTruthy());
  });
});
