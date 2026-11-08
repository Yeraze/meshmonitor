/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarkAllReadButton } from './MarkAllReadButton';

afterEach(() => vi.restoreAllMocks());

describe('MarkAllReadButton', () => {
  it('acts at once below the threshold, with no prompt', () => {
    const confirm = vi.spyOn(window, 'confirm');
    const onMarkAll = vi.fn();
    render(<MarkAllReadButton label="Mark" onMarkAll={onMarkAll} unreadCount={49} />);
    fireEvent.click(screen.getByText('Mark'));
    expect(confirm).not.toHaveBeenCalled();
    expect(onMarkAll).toHaveBeenCalledTimes(1);
  });

  it('asks at the threshold and honours cancel', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onMarkAll = vi.fn();
    render(<MarkAllReadButton label="Mark" onMarkAll={onMarkAll} unreadCount={50} confirmMessage="Clear {count}?" />);
    fireEvent.click(screen.getByText('Mark'));
    expect(confirm).toHaveBeenCalledWith('Clear 50?');
    expect(onMarkAll).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText('Mark'));
    expect(onMarkAll).toHaveBeenCalledTimes(1);
  });

  it('never asks without a count, and respects disabled', () => {
    const confirm = vi.spyOn(window, 'confirm');
    const onMarkAll = vi.fn();
    const { rerender } = render(<MarkAllReadButton label="Mark" onMarkAll={onMarkAll} />);
    fireEvent.click(screen.getByText('Mark'));
    expect(confirm).not.toHaveBeenCalled();
    expect(onMarkAll).toHaveBeenCalledTimes(1);
    rerender(<MarkAllReadButton label="Mark" onMarkAll={onMarkAll} disabled />);
    fireEvent.click(screen.getByText('Mark'));
    expect(onMarkAll).toHaveBeenCalledTimes(1);
  });
});
