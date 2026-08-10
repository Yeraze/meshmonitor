/**
 * NodeMultiFieldInput — stationary-first ordering and selection helpers.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NodeMultiFieldInput from './NodeMultiFieldInput';

const nodes = [
  { nodeNum: 1, longName: 'Mobile Rover', isMobile: true },
  { nodeNum: 2, longName: 'Roof Site', isMobile: false },
  { nodeNum: 3, longName: 'Tower Alpha', mobile: 0 },
];

describe('NodeMultiFieldInput', () => {
  it('lists stationary nodes before mobile ones and badges them', () => {
    render(<NodeMultiFieldInput value={[]} onChange={() => {}} nodes={nodes} />);
    const labels = screen.getAllByRole('checkbox').map((el) => el.parentElement?.textContent ?? '');
    expect(labels[0]).toMatch(/Roof Site/);
    expect(labels[1]).toMatch(/Tower Alpha/);
    expect(labels[2]).toMatch(/Mobile Rover/);
    expect(screen.getAllByText('Stationary').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Mobile')).toBeTruthy();
  });

  it('Select all stationary adds only stationary nodeNums', () => {
    const onChange = vi.fn();
    render(<NodeMultiFieldInput value={[]} onChange={onChange} nodes={nodes} />);
    fireEvent.click(screen.getByRole('button', { name: /Select all stationary/i }));
    expect(onChange).toHaveBeenCalledWith([2, 3]);
  });

  it('toggles a node into the selection', () => {
    const onChange = vi.fn();
    render(<NodeMultiFieldInput value={[]} onChange={onChange} nodes={nodes} />);
    const roof = screen.getAllByRole('checkbox').find((el) =>
      (el.parentElement?.textContent ?? '').includes('Roof Site')
    );
    expect(roof).toBeTruthy();
    fireEvent.click(roof!);
    expect(onChange).toHaveBeenCalledWith([2]);
  });
});
