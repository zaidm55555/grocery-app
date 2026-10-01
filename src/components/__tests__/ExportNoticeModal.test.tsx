import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import ExportNoticeModal, { ExportNotice } from '../ExportNoticeModal';

const notice = (over: Partial<ExportNotice> = {}): ExportNotice => ({
  platform: 'blinkit',
  outOfStock: [{ name: 'Gone Item' }],
  clamped: [{ name: 'Limited Item', requestedQty: 5, exportedQty: 2 }],
  missing: [{ name: 'Missing Item' }],
  itemCount: 3,
  onContinue: jest.fn(),
  ...over,
});

describe('ExportNoticeModal', () => {
  it('renders nothing without a notice', () => {
    const { toJSON } = render(<ExportNoticeModal notice={null} onCancel={jest.fn()} />);
    expect(toJSON()).toBeNull();
  });

  it('lists out-of-stock, clamped and missing items with a summary', () => {
    const { getByText } = render(<ExportNoticeModal notice={notice()} onCancel={jest.fn()} />);
    expect(getByText('Gone Item')).toBeTruthy();
    expect(getByText('Limited Item')).toBeTruthy();
    expect(getByText('5 → 2')).toBeTruthy();
    expect(getByText('Missing Item')).toBeTruthy();
    expect(getByText('3 in-stock items will be added')).toBeTruthy();
  });

  it('uses the singular form for one item and hides empty sections', () => {
    const { getByText, queryByText } = render(
      <ExportNoticeModal notice={notice({ itemCount: 1, clamped: [], missing: [] })} onCancel={jest.fn()} />,
    );
    expect(getByText('1 in-stock item will be added')).toBeTruthy();
    expect(queryByText('5 → 2')).toBeNull();
  });

  it('cancel closes without continuing', () => {
    const n = notice();
    const onCancel = jest.fn();
    const { getByText } = render(<ExportNoticeModal notice={n} onCancel={onCancel} />);
    fireEvent.press(getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(n.onContinue).not.toHaveBeenCalled();
  });

  it('continue closes the sheet and runs the export', () => {
    const n = notice();
    const onCancel = jest.fn();
    const { getByText } = render(<ExportNoticeModal notice={n} onCancel={onCancel} />);
    fireEvent.press(getByText(/^Continue to /));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(n.onContinue).toHaveBeenCalledTimes(1);
  });
});
