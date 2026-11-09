/**
 * @vitest-environment jsdom
 *
 * Repeater settings form (#6255 P9 S4): ranges from the shared schema,
 * airtime warnings, Off toggles, out-of-range current values, write-only
 * secrets, and only-changed-fields saves.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render each string as `key|params` so interpolated values can be asserted.
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock((key: string, a?: unknown, b?: unknown) => {
    const opts = (typeof a === 'object' && a !== null ? a : b) as Record<string, unknown> | undefined;
    const { defaultValue: _d, ...params } = opts ?? {};
    return Object.keys(params).length ? `${key}|${JSON.stringify(params)}` : key;
  });
});

import { RepeaterSettingsForm } from './RepeaterSettingsForm';
import type { RepeaterSettingsValues } from './hooks/useMeshCore';
import { estimateLoraAirtimeMs } from '../../utils/loraAirtime';

const VALUES: RepeaterSettingsValues = {
  advertInterval: 120,
  floodAdvertInterval: 24,
  floodMax: 8,
  repeat: true,
  af: 1,
  rxDelay: 0,
  txDelay: 0.5,
  directTxDelay: 0.3,
  allowReadOnly: false,
};
const RADIO = { sf: 10, bw: 250, cr: 5 };

function setup(over: Partial<React.ComponentProps<typeof RepeaterSettingsForm>> = {}) {
  const onSave = vi.fn().mockResolvedValue({ results: {}, read: true, drifted: false });
  const utils = render(
    <RepeaterSettingsForm
      values={VALUES}
      guestPasswordSet={false}
      firmwareVersion="v1.18.0"
      radio={RADIO}
      canWrite
      onSave={onSave}
      {...over}
    />,
  );
  return { onSave, ...utils };
}

const field = (key: string) => document.getElementById(`mc-rep-${key}`) as HTMLInputElement;
const type = (el: HTMLElement, value: string) => {
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
};

describe('RepeaterSettingsForm', () => {
  it('shows ranges from the shared schema, version-capped', () => {
    setup({ firmwareVersion: 'v1.11.0' });
    expect(screen.getAllByText(/meshcore\.repeater\.range\|\{"range":"60.240 min"\}/).length).toBe(1);
    expect(screen.getByText(/"range":"6.48 h"/)).toBeTruthy();
    expect(screen.getByText(/"range":"0.2 hops"|"range":"0.64 hops"/)).toBeTruthy();
    expect(screen.getByText(/"range":"0.9"/)).toBeTruthy();
  });

  it('computes the flood advert warning from the repeater radio', () => {
    setup();
    const ms = estimateLoraAirtimeMs(125, RADIO);
    const warn = screen.getByTestId('repeater-warn-flood').textContent ?? '';
    expect(warn).toContain('meshcore.repeater.warn_flood');
    // 24 h, 8 hops, 50 repeaters: 51 tx per advert, one advert a day.
    expect(warn).toContain('"txPerDay":51');
    expect(warn).toContain('"hops":8');
    // The airtime is nested in the `each` string, so its quotes are escaped.
    expect(warn).toMatch(new RegExp(`seconds\\\\*":\\\\*"${(ms / 1000).toFixed(1)}`));
  });

  it('warns on flood Off, af < 1, flood.max <= 2 and repeat off', () => {
    setup();
    expect(screen.queryByTestId('repeater-warn-af')).toBeNull();
    expect(screen.queryByTestId('repeater-warn-floodmax')).toBeNull();
    expect(screen.queryByTestId('repeater-warn-repeat')).toBeNull();

    type(field('af'), '0.5');
    expect(screen.getByTestId('repeater-warn-af')).toBeTruthy();
    type(field('floodMax'), '2');
    expect(screen.getByTestId('repeater-warn-floodmax')).toBeTruthy();
    fireEvent.click(screen.getByTestId('repeater-repeat'));
    expect(screen.getByTestId('repeater-warn-repeat')).toBeTruthy();
    fireEvent.click(screen.getByTestId('repeater-off-floodAdvertInterval'));
    expect(screen.getByTestId('repeater-warn-flood').textContent).toContain('warn_flood_off');
  });

  it('Off toggles send 0 for each interval', async () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByTestId('repeater-off-advertInterval'));
    fireEvent.click(screen.getByTestId('repeater-off-floodAdvertInterval'));
    expect(field('advertInterval').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('repeater-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ advertInterval: 0, floodAdvertInterval: 0 }));
  });

  it('sends only the changed fields, and nothing when nothing changed', async () => {
    const { onSave } = setup();
    const save = screen.getByTestId('repeater-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    type(field('floodMax'), '16');
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ floodMax: 16 }));
  });

  it('floors an odd advert interval to even before sending', async () => {
    const { onSave } = setup();
    type(field('advertInterval'), '121');
    fireEvent.click(screen.getByTestId('repeater-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ advertInterval: 120 }));
  });

  it('shows an out-of-range current value with a note and does not send it', async () => {
    const { onSave } = setup({ values: { ...VALUES, advertInterval: 2, floodMax: 8 } });
    expect(field('advertInterval').value).toBe('2');
    expect(screen.getByTestId('repeater-outofrange-advertInterval')).toBeTruthy();
    // Untouched: no change, save stays off.
    expect((screen.getByTestId('repeater-save') as HTMLButtonElement).disabled).toBe(true);
    type(field('floodMax'), '9');
    fireEvent.click(screen.getByTestId('repeater-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ floodMax: 9 }));
  });

  it('keeps secrets write-only: no value shown, blank omitted, set state only', async () => {
    const { onSave } = setup({ guestPasswordSet: true });
    expect((document.getElementById('mc-rep-admin-password') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('mc-rep-guest-password') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('repeater-guest-state').textContent).toBe('meshcore.repeater.guest_set');

    type(field('floodMax'), '10');
    fireEvent.click(screen.getByTestId('repeater-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ floodMax: 10 }));
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('adminPassword');
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('guestPassword');
  });

  it('sends a typed admin password, and rejects one over 15 bytes', async () => {
    const { onSave } = setup();
    const admin = document.getElementById('mc-rep-admin-password') as HTMLInputElement;
    fireEvent.change(admin, { target: { value: 'x'.repeat(16) } });
    expect((screen.getByTestId('repeater-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(admin, { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByTestId('repeater-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ adminPassword: 'hunter2' }));
  });

  it('turning guest login off sends an empty guest password', async () => {
    const { onSave } = setup({ guestPasswordSet: true });
    fireEvent.click(screen.getByTestId('repeater-clear-guest'));
    fireEvent.click(screen.getByTestId('repeater-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ guestPassword: '' }));
  });

  it('shows a result per key from the response', async () => {
    const onSave = vi.fn().mockResolvedValue({
      results: { floodMax: { ok: false, error: 'Error, max 64' }, rxDelay: { ok: true, changed: true, value: 1 } },
      drifted: false,
    });
    setup({ onSave });
    type(field('floodMax'), '10');
    type(field('rxDelay'), '1');
    fireEvent.click(screen.getByTestId('repeater-save'));
    expect((await screen.findByTestId('repeater-result-floodMax')).textContent).toContain('Error, max 64');
    expect(screen.getByTestId('repeater-result-rxDelay')).toBeTruthy();
  });

  it('is read-only without write permission', () => {
    setup({ canWrite: false });
    expect(field('floodMax').disabled).toBe(true);
    expect((screen.getByTestId('repeater-save') as HTMLButtonElement).disabled).toBe(true);
  });
});
