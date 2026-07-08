/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NodeMultiSelect from './NodeMultiSelect';

const NODES = [
  { key: 'mt:1', label: 'Alpha' },
  { key: 'mt:2', label: 'Bravo' },
  { key: 'mc:deadbeef', label: 'Charlie' },
];

describe('NodeMultiSelect', () => {
  it('shows "All nodes" when value is empty and no Clear button', () => {
    render(<NodeMultiSelect nodes={NODES} value={[]} onChange={vi.fn()} />);
    expect(screen.getByText('All nodes')).toBeInTheDocument();
    fireEvent.click(screen.getByText('All nodes'));
    expect(screen.queryByText('Clear')).not.toBeInTheDocument();
  });

  it('shows "N selected" and a Clear button when value is non-empty', () => {
    render(<NodeMultiSelect nodes={NODES} value={['mt:1']} onChange={vi.fn()} />);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByText('1 selected'));
    expect(screen.getByText('Clear')).toBeInTheDocument();
  });

  it('checking a box adds the key via onChange', () => {
    const onChange = vi.fn();
    render(<NodeMultiSelect nodes={NODES} value={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText('All nodes'));
    fireEvent.click(screen.getByLabelText('Bravo'));
    expect(onChange).toHaveBeenCalledWith(['mt:2']);
  });

  it('unchecking a box removes the key via onChange', () => {
    const onChange = vi.fn();
    render(<NodeMultiSelect nodes={NODES} value={['mt:1', 'mt:2']} onChange={onChange} />);
    fireEvent.click(screen.getByText('2 selected'));
    fireEvent.click(screen.getByLabelText('Alpha'));
    expect(onChange).toHaveBeenCalledWith(['mt:2']);
  });

  it('Select all calls onChange with every key', () => {
    const onChange = vi.fn();
    render(<NodeMultiSelect nodes={NODES} value={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText('All nodes'));
    fireEvent.click(screen.getByText('Select all'));
    expect(onChange).toHaveBeenCalledWith(['mt:1', 'mt:2', 'mc:deadbeef']);
  });

  it('Clear calls onChange with an empty array', () => {
    const onChange = vi.fn();
    render(<NodeMultiSelect nodes={NODES} value={['mt:1']} onChange={onChange} />);
    fireEvent.click(screen.getByText('1 selected'));
    fireEvent.click(screen.getByText('Clear'));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
