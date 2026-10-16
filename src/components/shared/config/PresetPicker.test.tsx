/**
 * @vitest-environment jsdom
 *
 * PresetPicker (#5831): the shared broker preset chips used by the Meshtastic
 * MQTT forms (select mode) and the Analyzer Observer broker list (add mode).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PresetPicker } from './PresetPicker';

const options = [
  { id: 'a', label: 'Alpha', title: 'mqtt://alpha:1883' },
  { id: 'b', label: 'Bravo' },
  { id: 'custom', label: 'Custom…' },
];

describe('PresetPicker', () => {
  it('labels the chip group and renders one button per option', () => {
    render(<PresetPicker label="Broker preset" options={options} onPick={vi.fn()} />);
    const group = screen.getByRole('group', { name: 'Broker preset' });
    expect(group.querySelectorAll('button')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('title', 'mqtt://alpha:1883');
  });

  it('select mode marks only the chosen chip as pressed', () => {
    render(<PresetPicker label="Preset" options={options} selectedId="b" onPick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Bravo' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('select mode with null presses nothing', () => {
    render(<PresetPicker label="Preset" options={options} selectedId={null} onPick={vi.fn()} />);
    expect(document.querySelector('[aria-pressed="true"]')).toBeNull();
  });

  it('add mode has no pressed state', () => {
    render(<PresetPicker label="Add" options={options} onPick={vi.fn()} />);
    expect(document.querySelector('[aria-pressed]')).toBeNull();
  });

  it('reports the picked id, every time, including the one already chosen', () => {
    const onPick = vi.fn();
    render(<PresetPicker label="Preset" options={options} selectedId="a" onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Custom…' }));
    expect(onPick.mock.calls).toEqual([['a'], ['custom']]);
  });

  it('chips are plain buttons, so a pick never submits a form', () => {
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    render(
      <form onSubmit={onSubmit as any}>
        <PresetPicker label="Preset" options={options} onPick={vi.fn()} />
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bravo' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disabled turns every chip off', () => {
    const onPick = vi.fn();
    render(<PresetPicker label="Preset" options={options} onPick={onPick} disabled />);
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('shows the description and the notes passed as children', () => {
    render(
      <PresetPicker label="Preset" description="Nothing is sent until you save." options={options} onPick={vi.fn()}>
        <p>privacy note</p>
      </PresetPicker>,
    );
    expect(screen.getByText('Nothing is sent until you save.')).toBeInTheDocument();
    expect(screen.getByText('privacy note')).toBeInTheDocument();
  });
});
