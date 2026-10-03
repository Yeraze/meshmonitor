/**
 * Tests for the "N hidden" chip beside the packet count (#5579).
 *
 * The global react-i18next mock (src/test/setup.ts) returns the key with
 * {{vars}} filled, so assertions match on keys.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PacketHiddenChip from './PacketHiddenChip';

describe('PacketHiddenChip', () => {
  it('renders nothing when no rows are hidden', () => {
    const { container } = render(<PacketHiddenChip count={0} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('packet-hidden-chip')).toBeNull();
  });

  it('renders nothing for a negative or NaN count', () => {
    const { container, rerender } = render(<PacketHiddenChip count={-1} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<PacketHiddenChip count={Number.NaN} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the count with a tooltip that names the filter', () => {
    render(<PacketHiddenChip count={12} />);
    const chip = screen.getByTestId('packet-hidden-chip');
    expect(chip).toHaveTextContent('packet_monitor.hidden_count');
    expect(chip).toHaveAttribute('title', 'packet_monitor.hidden_tooltip');
    expect(chip).toHaveAttribute('aria-label', 'packet_monitor.hidden_tooltip');
  });

  it('calls onClick so the panel can open the filter drawer', () => {
    const onClick = vi.fn();
    render(<PacketHiddenChip count={3} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
