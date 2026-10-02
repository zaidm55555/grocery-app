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

  it('replaces the basket when loading with an empty basket (no prompt)', async () => {
    await lists.save('Staples', cart);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { findByText, onCartChanged, onClose } = setup([]);
    fireEvent.press(await findByText('Staples'));
    await waitFor(() => expect(onCartChanged).toHaveBeenCalled());
    expect(alert).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('can replace the current basket from the load prompt', async () => {
    await lists.save('Staples', cart);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const other = [{ product: product({ id: 'z' }), quantity: 5 }];
    const { findByText, onCartChanged } = setup(other);
    fireEvent.press(await findByText('Staples'));
    await alert.mock.calls[0][2]!.find(b => b.text === 'Replace')!.onPress!();
    await waitFor(() => expect(onCartChanged).toHaveBeenCalled());
    expect(onCartChanged.mock.calls[0][0].map((l: any) => l.product.id)).toEqual(['a']);
  });

  it('asks before overwriting a list with the same name (case-insensitive) and only saves on Replace', async () => {
    await lists.save('Weekly', [{ product: product({ id: 'old' }), quantity: 1 }]);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { getByPlaceholderText, getByText, findByText } = setup();
    await findByText('Weekly');
    fireEvent.changeText(getByPlaceholderText(/Name this basket/), 'weekly');
    fireEvent.press(getByText('Save'));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][0]).toBe('Replace list?');
    expect((await lists.getAll())[0].items[0].product.id).toBe('old'); // not yet
    await alert.mock.calls[0][2]!.find(b => b.text === 'Replace')!.onPress!();
    await waitFor(async () => expect((await lists.getAll())[0].items[0].product.id).toBe('a'));
  });

  it('hides the save row for an empty basket, and ignores a blank name', async () => {
    const empty = setup([]);
    expect(empty.queryByPlaceholderText(/Name this basket/)).toBeNull();
    const { getByPlaceholderText, getByText } = setup();
    fireEvent.changeText(getByPlaceholderText(/Name this basket/), '   ');
    fireEvent.press(getByText('Save'));
    expect(await lists.getAll()).toEqual([]);
  });

  it('deletes a list only after confirmation', async () => {
    await lists.save('Staples', cart);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { findByText, UNSAFE_getAllByType, queryByText } = setup();
    await findByText('Staples');
    const { TouchableOpacity } = require('react-native');
    const touchables = UNSAFE_getAllByType(TouchableOpacity);
    fireEvent.press(touchables[touchables.length - 1]); // the row's delete icon
    expect(alert.mock.calls[0][0]).toBe('Delete list');
    expect((await lists.getAll()).length).toBe(1);
    await alert.mock.calls[0][2]!.find(b => b.text === 'Delete')!.onPress!();
    await waitFor(() => expect(queryByText('Staples')).toBeNull());
    expect(await lists.getAll()).toEqual([]);
  });

  it('shows relative ages and pluralised counts', async () => {
    await lists.save('One', cart);
    const { findByText } = setup();
    expect(await findByText(/1 item · 2 units · just now/)).toBeTruthy();
  });

  it('closes via the close button', async () => {
    const { UNSAFE_getAllByType, onClose } = setup();
    const { TouchableOpacity } = require('react-native');
    fireEvent.press(UNSAFE_getAllByType(TouchableOpacity).find((t: any) => t.props.hitSlop)!);
    expect(onClose).toHaveBeenCalled();
  });
});
