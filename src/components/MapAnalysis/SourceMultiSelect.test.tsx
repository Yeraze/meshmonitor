/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SourceMultiSelect from './SourceMultiSelect';

const sources = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C' },
];

describe('SourceMultiSelect', () => {
  it('shows "All sources (N)" when value is empty', () => {
    render(<SourceMultiSelect sources={sources} value={[]} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /all sources/i })).toHaveTextContent(/all sources \(3\)/i);
  });

  it('shows count when sources are selected', () => {
    render(<SourceMultiSelect sources={sources} value={['a', 'b']} onChange={() => {}} />);
    expect(screen.getByRole('button')).toHaveTextContent(/2 sources/i);
  });

  it('toggles a source on checkbox click', () => {
    const onChange = vi.fn();
    render(<SourceMultiSelect sources={sources} value={['a']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByLabelText('B'));
    expect(onChange).toHaveBeenCalledWith(['a', 'b']);
  });
});
