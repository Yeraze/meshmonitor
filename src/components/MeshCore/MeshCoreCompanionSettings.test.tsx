/**
 * @vitest-environment jsdom
 *
 * BLE PIN and multi-ACK sections (P8a #6257).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { MeshCoreBlePinSection } from './MeshCoreBlePinSection';
import { MeshCoreMultiAcksSection } from './MeshCoreMultiAcksSection';

describe('MeshCoreBlePinSection', () => {
  const setup = (pin: number | null = 0) => {
    const actions = {
      getBlePin: vi.fn().mockResolvedValue(pin),
      setBlePin: vi.fn().mockResolvedValue(true),
    };
    render(<MeshCoreBlePinSection connected canWriteConfig actions={actions} />);
    return actions;
  };

  it('shows the reboot / Bluetooth-only note', async () => {
    const a = setup();
    await waitFor(() => expect(a.getBlePin).toHaveBeenCalled());
    expect(screen.getByText('meshcore.ble_pin.note')).toBeTruthy();
  });

  it('saves 0 for the firmware default', async () => {
    const a = setup(654321);
    await waitFor(() => expect(screen.getByRole('spinbutton')).toBeTruthy());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'meshcore.ble_pin.save' }));
    await waitFor(() => expect(a.setBlePin).toHaveBeenCalledWith(0));
  });

  it('saves a valid fixed PIN', async () => {
    const a = setup(0);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '246810' } });
    fireEvent.click(screen.getByRole('button', { name: 'meshcore.ble_pin.save' }));
    await waitFor(() => expect(a.setBlePin).toHaveBeenCalledWith(246810));
  });

  it('blocks a fixed PIN outside 100000-999999', async () => {
    const a = setup(0);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1234' } });
    const save = screen.getByRole('button', { name: 'meshcore.ble_pin.save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(a.setBlePin).not.toHaveBeenCalled();
  });
});

describe('MeshCoreMultiAcksSection', () => {
  it('shows the airtime warning', () => {
    render(<MeshCoreMultiAcksSection connected canWriteConfig actions={{ setMultiAcks: vi.fn() }} multiAcks={0} firmwareVer={7} />);
    expect(screen.getByRole('note').textContent).toContain('meshcore.multi_acks.warning');
  });

  it('sends 1 when turned on and saved, 0 when turned off', async () => {
    const setMultiAcks = vi.fn().mockResolvedValue(true);
    const { rerender } = render(<MeshCoreMultiAcksSection connected canWriteConfig actions={{ setMultiAcks }} multiAcks={0} firmwareVer={7} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'meshcore.multi_acks.save' }));
    await waitFor(() => expect(setMultiAcks).toHaveBeenCalledWith(1));
    rerender(<MeshCoreMultiAcksSection connected canWriteConfig actions={{ setMultiAcks }} multiAcks={1} firmwareVer={7} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'meshcore.multi_acks.save' }));
    await waitFor(() => expect(setMultiAcks).toHaveBeenLastCalledWith(0));
  });

  it('is disabled on firmware before v7', () => {
    render(<MeshCoreMultiAcksSection connected canWriteConfig actions={{ setMultiAcks: vi.fn() }} multiAcks={0} firmwareVer={6} />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  });
});
