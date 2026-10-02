import React from 'react';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import SavedListsModal from '../SavedListsModal';
import { lists } from '../../services/lists';
import { product } from '../../services/__tests__/fixtures';

const cart = [{ product: product({ id: 'a' }), quantity: 2 }];
const setup = (items = cart) => {
  const onCartChanged = jest.fn();
  const onClose = jest.fn();
  const utils = render(<SavedListsModal visible onClose={onClose} cartItems={items} onCartChanged={onCartChanged} />);
  return { ...utils, onCartChanged, onClose };
};

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('SavedListsModal', () => {
  it('shows empty state', async () => {
    const { findByText } = setup();
    expect(await findByText(/No saved lists yet/)).toBeTruthy();
  });

  it('saves the current basket under a name', async () => {
    const { getByPlaceholderText, getByText, findByText } = setup();
    fireEvent.changeText(getByPlaceholderText(/Name this basket/), 'Weekly');
    fireEvent.press(getByText('Save'));
    expect(await findByText('Weekly')).toBeTruthy();
    expect((await lists.getAll())[0].name).toBe('Weekly');
  });

  it('lists existing saved lists', async () => {
    await lists.save('Staples', cart);
    const { findByText } = setup();
    expect(await findByText('Staples')).toBeTruthy();
  });

  it('asks before loading a list and can add it to the basket', async () => {
    await lists.save('Staples', cart);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { findByText, onCartChanged } = setup();
    fireEvent.press(await findByText('Staples'));
    expect(alert).toHaveBeenCalled();
    const buttons = alert.mock.calls[0][2]!;
    await buttons.find(b => b.text === 'Add to basket')!.onPress!();
    await waitFor(() => expect(onCartChanged).toHaveBeenCalled());
  });
});
