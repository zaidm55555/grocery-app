import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import VariantPickerModal from '../VariantPickerModal';
import { product } from '../../services/__tests__/fixtures';

const base = product({ id: 'blinkit-1', title: 'Tata Salt 1kg', quantity: '1 kg', price: 28 });
const opt = (id: string, over: any = {}) => product({ id, title: `Salt ${id}`, platform: 'blinkit', quantity: id, price: 28, ...over });

const setup = (over: any = {}) => {
  const h = { onPick: jest.fn(), onClose: jest.fn() };
  const props = { visible: true, base, options: [base], qtyFor: () => 0, ...h, ...over };
  return { ...render(<VariantPickerModal {...props} />), ...h };
};

beforeEach(() => jest.spyOn(Alert, 'alert').mockImplementation(() => {}));

describe('VariantPickerModal', () => {
  it('renders nothing without a base product', () => {
    const { toJSON } = setup({ base: null });
    expect(toJSON()).toBeNull();
  });

  it('shows the header with the app name and size count (singular/plural)', () => {
    expect(setup().getByText('Blinkit · 1 size')).toBeTruthy();
    const two = setup({ options: [base, opt('b2')] });
    expect(two.getByText('Blinkit · 2 sizes')).toBeTruthy();
  });

  it('adds the tapped listing', () => {
    const o = opt('500 g');
    const { getByText, onPick } = setup({ options: [base, o] });
    fireEvent.press(getByText('Salt 500 g'));
    expect(onPick).toHaveBeenCalledWith(o);
  });

  it('shows the current quantity badge', () => {
    const { getByText } = setup({ qtyFor: (p: any) => (p.id === 'blinkit-1' ? 3 : 0) });
    expect(getByText('×3')).toBeTruthy();
  });

  it('shows price, MRP and discount', () => {
    const o = opt('d', { price: 80, originalPrice: 100 });
    const { getByText } = setup({ options: [base, o] });
    expect(getByText('₹80')).toBeTruthy();
    expect(getByText('₹100')).toBeTruthy();
    expect(getByText('20%')).toBeTruthy();
  });

  it('blocks out-of-stock listings with an alert and a badge', () => {
    const o = opt('oos', { inStock: false });
    const { getByText, onPick } = setup({ options: [base, o] });
    expect(getByText('OUT OF STOCK')).toBeTruthy();
    fireEvent.press(getByText('Salt oos'));
    expect(Alert.alert).toHaveBeenCalledWith('Out of Stock', expect.stringContaining('Blinkit'));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('treats a zero stock limit as out of stock', () => {
    const o = opt('zero', { availableStock: 0 });
    const { getByText } = setup({ options: [base, o] });
    expect(getByText('OUT OF STOCK')).toBeTruthy();
  });

  it('blocks adding beyond the stock limit', () => {
    const o = opt('lim', { availableStock: 2 });
    const { getByText, onPick } = setup({ options: [base, o], qtyFor: (p: any) => (p.id === 'lim' ? 2 : 0) });
    expect(getByText('MAX IN STOCK (2)')).toBeTruthy();
    fireEvent.press(getByText('Salt lim'));
    expect(Alert.alert).toHaveBeenCalledWith('Stock Limit Reached', 'Only 2 units available on Blinkit.');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('uses the singular in the limit alert for one unit', () => {
    const o = opt('one', { availableStock: 1 });
    const { getByText } = setup({ options: [base, o], qtyFor: () => 1 });
    fireEvent.press(getByText('Salt one'));
    expect(Alert.alert).toHaveBeenCalledWith('Stock Limit Reached', 'Only 1 unit available on Blinkit.');
  });

  it('still allows adding when under the limit', () => {
    const o = opt('ok', { availableStock: 5 });
    const { getByText, onPick } = setup({ options: [base, o], qtyFor: () => 1 });
    fireEvent.press(getByText('Salt ok'));
    expect(onPick).toHaveBeenCalledWith(o);
  });

  it('groups by app with the base app first when listings span both apps', () => {
    const sw = product({ id: 'swiggy-1', title: 'Swiggy Salt', platform: 'swiggy', quantity: '1 kg' });
    const { getByText, toJSON } = setup({ options: [sw, base] });
    expect(getByText('Blinkit')).toBeTruthy();
    expect(getByText('Instamart')).toBeTruthy();
    const json = JSON.stringify(toJSON());
    expect(json.indexOf('Blinkit')).toBeLessThan(json.indexOf('Instamart'));
  });

  it('does not show app section headers for a single app', () => {
    expect(setup().queryByText('Instamart')).toBeNull();
  });

  it('calls onClose from the close button', () => {
    const { UNSAFE_getAllByType, onClose } = setup();
    const { TouchableOpacity } = require('react-native');
    const touchables = UNSAFE_getAllByType(TouchableOpacity);
    // backdrop, sheet, close button, rows — the close button is the first with a hitSlop
    const close = touchables.find((t: any) => t.props.hitSlop);
    fireEvent.press(close!);
    expect(onClose).toHaveBeenCalled();
  });
});
