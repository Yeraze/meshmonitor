/**
 * @vitest-environment jsdom
 *
 * Repeater settings form in remote mode (#6256 P10): per-group reads with a
 * cost line, flood warning, Room Server and remote-only field rules, TX power
 * warning, NOT_SENT / unverified results, and export / import.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock((key: string, a?: unknown, b?: unknown) => {
    const opts = (typeof a === 'object' && a !== null ? a : b) as Record<string, unknown> | undefined;
    const { defaultValue: _d, ...params } = opts ?? {};
    return Object.keys(params).length ? `${key}|${JSON.stringify(params)}` : key;
  });
});

import { RepeaterSettingsForm } from './RepeaterSettingsForm';
import type { RemoteSettingsGroup, RepeaterSettingsValues } from './hooks/useMeshCore';
import { estimateLoraAirtimeMs } from '../../utils/loraAirtime';

const RADIO = { sf: 10, bw: 250, cr: 5 };
const ADVERTS: RepeaterSettingsValues = {
  advertInterval: 120,
  floodAdvertInterval: 24,
  floodMax: 8,
  repeat: true,
  af: 1,
  rxDelay: 0,
  txDelay: 0.5,
  directTxDelay: 0.3,
};
const IDENTITY: RepeaterSettingsValues = { name: 'Hill', lat: 12.5, lon: -80.25, txPower: 22, radio: '869.618,62.5,8,8' };

function setup(over: Partial<React.ComponentProps<typeof RepeaterSettingsForm>> = {}) {
  const onSave = vi.fn().mockResolvedValue({ results: {}, drifted: false });
  const onReadGroup = vi.fn();
  const utils = render(
    <RepeaterSettingsForm
      mode="remote"
      deviceType="repeater"
      values={{}}
      guestPasswordSet={false}
      firmwareVersion="v1.18.0"
      radio={RADIO}
      canWrite
      onSave={onSave}
      onReadGroup={onReadGroup}
      loadedGroups={new Set<RemoteSettingsGroup>()}
      pathHops={0}
      {...over}
    />,
  );
  return { onSave, onReadGroup, ...utils };
}

const field = (key: string) => document.getElementById(`mc-rep-${key}`) as HTMLInputElement;

describe('RepeaterSettingsForm (remote)', () => {
  it('reads nothing on mount and reads one group per button', () => {
    const { onReadGroup, onSave } = setup();
    expect(onReadGroup).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('repeater-read-adverts'));
    expect(onReadGroup).toHaveBeenCalledTimes(1);
    expect(onReadGroup).toHaveBeenCalledWith('adverts');
  });

  it('shows the cost from the local radio and the hop count', () => {
    setup({ pathHops: 2 });
    const perKey = estimateLoraAirtimeMs(38, RADIO) + estimateLoraAirtimeMs(22, RADIO);
    const cost = screen.getByTestId('repeater-cost-adverts').textContent ?? '';
    expect(cost).toContain('meshcore.repeater.remote_cost');
    expect(cost).toContain('"count":8');
    expect(cost).toContain('"packets":16');
    expect(cost).toContain('"hops":3');
    const seconds = JSON.parse(cost.split('|')[1]).seconds;
    expect(Number(seconds)).toBeCloseTo((8 * perKey * 3) / 1000, 0);
    expect(screen.queryByTestId('repeater-flood-adverts')).toBeNull();
  });

  it('warns that commands flood when no path is known', () => {
    setup({ pathHops: null });
    expect(screen.getByTestId('repeater-flood-adverts')).toBeTruthy();
    expect(screen.getByTestId('repeater-flood-identity')).toBeTruthy();
  });

  it('does not offer the admin password remotely', () => {
    setup({ loadedGroups: new Set(['access']), values: { allowReadOnly: false } });
    expect(document.getElementById('mc-rep-admin-password')).toBeNull();
    expect(screen.getByTestId('repeater-admin-console-only')).toBeTruthy();
    expect(document.getElementById('mc-rep-guest-password')).toBeTruthy();
  });

  it('hides the forwarding knobs on a Room Server', () => {
    setup({ deviceType: 'room', loadedGroups: new Set(['adverts']), values: { advertInterval: 120, floodAdvertInterval: 24, af: 1 } });
    for (const key of ['floodMax', 'rxDelay', 'txDelay', 'directTxDelay']) expect(field(key)).toBeNull();
    expect(screen.queryByTestId('repeater-repeat')).toBeNull();
    expect(field('advertInterval')).toBeTruthy();
    const cost = screen.getByTestId('repeater-cost-adverts').textContent ?? '';
    expect(cost).toContain('"count":3');
  });

  it('shows the radio read-only and warns on a TX power change', () => {
    setup({ loadedGroups: new Set(['identity']), values: IDENTITY });
    expect(screen.getByTestId('repeater-radio').textContent).toBe('869.618,62.5,8,8');
    expect(document.querySelector('input[value="869.618,62.5,8,8"]')).toBeNull();
    expect(screen.queryByTestId('repeater-warn-txpower')).toBeNull();
    fireEvent.change(field('txPower'), { target: { value: '10' } });
    fireEvent.blur(field('txPower'));
    expect(screen.getByTestId('repeater-warn-txpower')).toBeTruthy();
  });

  it('saves only the changed keys of read groups', async () => {
    const { onSave } = setup({ loadedGroups: new Set(['identity', 'adverts']), values: { ...IDENTITY, ...ADVERTS } });
    fireEvent.change(screen.getByTestId('repeater-name'), { target: { value: 'Ridge' } });
    fireEvent.change(field('floodMax'), { target: { value: '5' } });
    fireEvent.blur(field('floodMax'));
    fireEvent.click(screen.getByTestId('repeater-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ name: 'Ridge', floodMax: 5 });
  });

  it('keeps Save off while every group is unread', () => {
    setup();
    expect((screen.getByTestId('repeater-save') as HTMLButtonElement).disabled).toBe(true);
    expect(field('floodMax').disabled).toBe(true);
  });

  it('blocks an invalid name', () => {
    setup({ loadedGroups: new Set(['identity']), values: IDENTITY });
    fireEvent.change(screen.getByTestId('repeater-name'), { target: { value: 'x'.repeat(32) } });
    expect((screen.getByTestId('repeater-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders NOT_SENT and unverified results', async () => {
    const onSave = vi.fn().mockResolvedValue({
      results: {
        floodMax: { ok: true, changed: true, verified: false },
        af: { ok: false, changed: false, code: 'NOT_SENT' },
      },
    });
    setup({ onSave, loadedGroups: new Set(['adverts']), values: ADVERTS });
    fireEvent.change(field('floodMax'), { target: { value: '5' } });
    fireEvent.blur(field('floodMax'));
    fireEvent.change(field('af'), { target: { value: '2' } });
    fireEvent.blur(field('af'));
    fireEvent.click(screen.getByTestId('repeater-save'));
    await waitFor(() => expect(screen.getByTestId('repeater-result-af')).toBeTruthy());
    expect(screen.getByTestId('repeater-result-af').textContent).toContain('meshcore.repeater.remote_not_sent');
    expect(screen.getByTestId('repeater-result-floodMax').textContent).toContain('meshcore.repeater.remote_unverified');
  });

  it('disables export until something was read', () => {
    setup();
    expect((screen.getByTestId('repeater-export') as HTMLButtonElement).disabled).toBe(true);
  });

  it('imports into the draft without saving', async () => {
    const { onSave } = setup({ loadedGroups: new Set(['adverts']), values: ADVERTS });
    const file = new File([JSON.stringify({
      schema: 'meshmonitor.meshcore.repeater-settings',
      v: 1,
      deviceType: 'repeater',
      firmware: null,
      exportedAt: '2026-11-09T00:00:00Z',
      values: { floodMax: 6, name: 'Other' },
    })], 'settings.json', { type: 'application/json' });
    fireEvent.change(screen.getByTestId('repeater-import-file'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('repeater-import-notes')).toBeTruthy());
    expect(field('floodMax').value).toBe('6');
    // Identity keys are skipped unless "include identity" is on.
    expect(screen.getByTestId('repeater-import-notes').textContent).toContain('name');
    expect(onSave).not.toHaveBeenCalled();
  });
});
