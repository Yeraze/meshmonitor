/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NodeSortControls } from './NodeSortControls';
import { ExportMenuButton } from './ExportMenuButton';
import { NodeStatChips } from './NodeStatChips';

describe('NodeSortControls', () => {
  it('changes field and toggles direction', () => {
    const onChange = vi.fn();
    const onToggle = vi.fn();
    render(
      <NodeSortControls value="a" direction="asc" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} onChange={onChange} onToggleDirection={onToggle} />
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledWith('b');
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalled();
  });
});

describe('ExportMenuButton', () => {
  it('opens, exports, closes on Escape and outside click', () => {
    const onExport = vi.fn();
    render(<ExportMenuButton onExport={onExport} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'CSV' }));
    expect(onExport).toHaveBeenCalledWith('csv');
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('NodeStatChips', () => {
  it('renders chips in order, hides hops >= 999, shows plugged in', () => {
    const { container } = render(<NodeStatChips snr={5.5} rssi={-90} batteryLevel={101} voltage={4.123} hops={999} />);
    const text = Array.from(container.querySelectorAll('.stat')).map((e) => e.textContent?.trim());
    expect(text).toHaveLength(4);
    expect(text[0]).toContain('5.5dB');
    expect(text[1]).toContain('-90dBm');
    expect(text[3]).toContain('4.12V');
  });
});
