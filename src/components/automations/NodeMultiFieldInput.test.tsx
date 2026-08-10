/**
 * NodeMultiFieldInput — stationary-first ordering and selection helpers.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NodeMultiFieldInput, { labelOf } from './NodeMultiFieldInput';

const nodes = [
  { nodeNum: 1, longName: 'Mobile Rover', shortName: 'ROVR', nodeId: '!00000001', isMobile: true },
  { nodeNum: 2, longName: 'Roof Site', shortName: 'ROOF', nodeId: '!00000002', isMobile: false },
  { nodeNum: 3, longName: 'Tower Alpha', shortName: 'TWR', nodeId: '!00000003', mobile: 0 },
  { nodeNum: 4, nodeId: '!00000004', isMobile: false }, // no name — falls back to id
];

describe('labelOf', () => {
  it('prefers longName, then shortName, then nodeId, then hex nodeNum', () => {
    expect(labelOf({ nodeNum: 1, longName: 'A', shortName: 'B', nodeId: '!x' })).toBe('A');
    expect(labelOf({ nodeNum: 1, shortName: 'B', nodeId: '!x' })).toBe('B');
    expect(labelOf({ nodeNum: 1, nodeId: '!x' })).toBe('!x');
    expect(labelOf({ nodeNum: 255 })).toBe('!000000ff');
  });
});

describe('NodeMultiFieldInput', () => {
  it('lists stationary nodes before mobile ones and shows human names', () => {
    render(<NodeMultiFieldInput value={[]} onChange={() => {}} nodes={nodes} />);
    const labels = screen.getAllByRole('checkbox').map((el) => el.parentElement?.textContent ?? '');
    expect(labels[0]).toMatch(/Roof Site/);
    expect(labels[1]).toMatch(/Tower Alpha/);
    expect(labels.some((t) => t.includes('Mobile Rover'))).toBe(true);
    expect(labels.every((t) => !/#\d+Stationary/.test(t.replace(/\s/g, '')))).toBe(true);
    expect(screen.getAllByText('Stationary').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Mobile')).toBeTruthy();
  });

  it('Select all stationary adds only stationary nodeNums', () => {
    const onChange = vi.fn();
    render(<NodeMultiFieldInput value={[]} onChange={onChange} nodes={nodes} />);
    fireEvent.click(screen.getByRole('button', { name: /Select all stationary/i }));
    expect(onChange).toHaveBeenCalledWith([2, 3, 4]);
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
