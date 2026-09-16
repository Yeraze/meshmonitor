/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HopLimitOverrideSelect } from './HopLimitOverrideSelect';

describe('HopLimitOverrideSelect (#5121)', () => {
  it('offers inherit plus every hop count from 0 to 7', () => {
    render(<HopLimitOverrideSelect id="hl" value="" onChange={vi.fn()} />);
    const values = Array.from((screen.getByRole('combobox') as HTMLSelectElement).options).map((o) => o.value);
    expect(values).toEqual(['', '0', '1', '2', '3', '4', '5', '6', '7']);
  });

  it('reports the chosen value as a string', () => {
    const onChange = vi.fn();
    render(<HopLimitOverrideSelect id="hl" value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '0' } });
    expect(onChange).toHaveBeenCalledWith('0');
  });

  it('shows the zero-hop trade-off only when 0 is selected', () => {
    const note = 'sent once, no confirmation';
    const { rerender } = render(<HopLimitOverrideSelect id="hl" value="2" onChange={vi.fn()} zeroHopNote={note} />);
    expect(screen.queryByText(note)).toBeNull();
    rerender(<HopLimitOverrideSelect id="hl" value="0" onChange={vi.fn()} zeroHopNote={note} />);
    expect(screen.getByText(note)).toBeTruthy();
  });
});
