/**
 * @vitest-environment jsdom
 *
 * MeshCore Timer Trigger editor — multi-channel checkboxes (#6230).
 *
 * The single channel <select> became a checkbox-per-channel list (destination
 * "channel"), matching the Auto-Announce UI and the Meshtastic timer. The
 * destination <select> and the DM path are unchanged.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const t = (key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
    let s = typeof fallback === 'string' ? fallback : key;
    const vars = (typeof fallback === 'object' ? fallback : opts) ?? {};
    for (const [k, v] of Object.entries(vars)) s = s.replace(`{{${k}}}`, String(v));
    return s;
  };
  return createReactI18nextMock(t);
});

// Isolate the editor from the region-fetching scope field and the advert field.
vi.mock('./ScopeSelectField', () => ({ ScopeSelectField: () => null }));
vi.mock('./MeshCoreAdvertModeField', () => ({ MeshCoreAdvertModeField: () => null }));

import { MeshCoreTimerTriggerEditor } from './MeshCoreTimerTriggerEditor';
import { validateMeshCoreTimer, type MeshCoreTimerTrigger } from './meshcoreTimerModel';

const CHANNELS = [
  { id: 0, name: 'Primary' },
  { id: 1, name: 'gauntlet' },
  { id: 2, name: 'admin' },
];

const baseTrigger = (over: Partial<MeshCoreTimerTrigger>): MeshCoreTimerTrigger => ({
  id: 'c1',
  name: 'beacon',
  enabled: true,
  scheduleType: 'interval',
  intervalMinutes: 60,
  responseType: 'text',
  response: 'hi',
  destination: 'channel',
  channelIndexes: [0],
  scopeMode: 'inherit',
  scopeName: '',
  ...over,
});

function renderEditor(trigger: MeshCoreTimerTrigger) {
  const onChange = vi.fn();
  const utils = render(
    <MeshCoreTimerTriggerEditor
      trigger={trigger}
      onChange={onChange}
      errors={{}}
      channels={CHANNELS}
      contacts={[]}
      scripts={[]}
      baseUrl=""
      sourceId="s1"
    />,
  );
  return { onChange, ...utils };
}

describe('MeshCoreTimerTriggerEditor multi-channel (#6230)', () => {
  it('renders a checkbox per channel and checks the selected ones', () => {
    const { getByLabelText } = renderEditor(baseTrigger({ channelIndexes: [0, 2] }));
    expect((getByLabelText('Primary') as HTMLInputElement).checked).toBe(true);
    expect((getByLabelText('gauntlet') as HTMLInputElement).checked).toBe(false);
    expect((getByLabelText('admin') as HTMLInputElement).checked).toBe(true);
  });

  it('adds a channel to channelIndexes when its box is checked', () => {
    const { getByLabelText, onChange } = renderEditor(baseTrigger({ channelIndexes: [0] }));
    fireEvent.click(getByLabelText('gauntlet'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ channelIndexes: [0, 1], channelIndex: undefined }));
  });

  it('removes a channel when its box is unchecked', () => {
    const { getByLabelText, onChange } = renderEditor(baseTrigger({ channelIndexes: [0, 2] }));
    fireEvent.click(getByLabelText('Primary'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ channelIndexes: [2] }));
  });

  it('migrates an old single channelIndex into a checked box', () => {
    const { getByLabelText } = renderEditor(baseTrigger({ channelIndexes: undefined, channelIndex: 1 }));
    expect((getByLabelText('gauntlet') as HTMLInputElement).checked).toBe(true);
    expect((getByLabelText('Primary') as HTMLInputElement).checked).toBe(false);
  });

  it('shows the contact picker (no channel boxes) for a DM timer', () => {
    const { queryByLabelText } = renderEditor(baseTrigger({ destination: 'dm' }));
    expect(queryByLabelText('Primary')).toBeNull();
  });

  it('disables the unticked boxes once 4 channels are ticked (4.17.3 review M5)', () => {
    const five = [...CHANNELS, { id: 3, name: 'four' }, { id: 4, name: 'five' }];
    const onChange = vi.fn();
    const { getByLabelText, getByText } = render(
      <MeshCoreTimerTriggerEditor
        trigger={baseTrigger({ channelIndexes: [0, 1, 2, 3] })}
        onChange={onChange} errors={{}} channels={five} contacts={[]} scripts={[]} baseUrl="" sourceId="s1"
      />,
    );
    expect((getByLabelText('five') as HTMLInputElement).disabled).toBe(true);
    expect((getByLabelText('Primary') as HTMLInputElement).disabled).toBe(false);
    expect(getByText(/Up to 4 channels/)).toBeTruthy();
  });

  it('validation flags a stored timer with more than 4 channels', () => {
    const t = (_k: string, fallback: string, opts?: Record<string, unknown>) =>
      fallback.replace('{{max}}', String(opts?.max ?? ''));
    expect(validateMeshCoreTimer(baseTrigger({ channelIndexes: [0, 1, 2, 3, 4] }), false, t).channels)
      .toBe('A timer can send to at most 4 channels.');
    expect(validateMeshCoreTimer(baseTrigger({ channelIndexes: [0, 1, 2, 3] }), false, t).channels).toBeUndefined();
    expect(validateMeshCoreTimer(baseTrigger({ destination: 'dm', channelIndexes: [0, 1, 2, 3, 4] }), false, t).channels).toBeUndefined();
  });
});
