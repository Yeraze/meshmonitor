/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BluetoothPinField } from './BluetoothPinField';

const base = {
  pin: 123456,
  onPinChange: vi.fn(),
  onModeChange: vi.fn(),
  fixedRange: { min: 100000, max: 999999 },
};

describe('BluetoothPinField', () => {
  it('offers exactly the modes it is given, in order', () => {
    render(<BluetoothPinField {...base} modes={['random', 'fixed', 'none']} mode="random" />);
    const opts = Array.from(screen.getByRole('combobox').querySelectorAll('option')).map((o) => o.textContent);
    expect(opts).toEqual([
      'admin_commands.bluetooth_mode_random_pin',
      'admin_commands.bluetooth_mode_fixed_pin',
      'admin_commands.bluetooth_mode_no_pin',
    ]);
  });

  it('hides the PIN input unless the mode is fixed', () => {
    const { rerender } = render(<BluetoothPinField {...base} modes={['default', 'fixed']} mode="default" />);
    expect(screen.queryByRole('spinbutton')).toBeNull();
    rerender(<BluetoothPinField {...base} modes={['default', 'fixed']} mode="fixed" />);
    expect(screen.getByRole('spinbutton')).toBeTruthy();
  });

  it('reports the chosen mode by name', () => {
    const onModeChange = vi.fn();
    render(<BluetoothPinField {...base} onModeChange={onModeChange} modes={['default', 'fixed']} mode="default" />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } });
    expect(onModeChange).toHaveBeenCalledWith('fixed');
  });

  it('applies fixedRange: an out-of-range PIN is not reported', () => {
    const onPinChange = vi.fn();
    render(<BluetoothPinField {...base} onPinChange={onPinChange} modes={['default', 'fixed']} mode="fixed" />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '123' } });
    expect(onPinChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '654321' } });
    expect(onPinChange).toHaveBeenCalledWith(654321);
  });

  it('shows the note', () => {
    render(<BluetoothPinField {...base} modes={['default']} mode="default" note="after reboot" />);
    expect(screen.getByText('after reboot')).toBeTruthy();
  });
});
