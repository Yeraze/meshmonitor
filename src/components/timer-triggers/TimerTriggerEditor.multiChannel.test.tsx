/**
 * @vitest-environment jsdom
 *
 * Meshtastic Timer Trigger editor — multi-channel checkboxes (#6230).
 *
 * The single channel <select> became a checkbox-per-channel list, mirroring the
 * Auto Responder. A text timer shows only channel boxes; a script timer also
 * shows the exclusive "None (no mesh output)" box.
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

import TimerTriggerEditor from './TimerTriggerEditor';
import type { TimerTrigger } from '../auto-responder/types';

const CHANNELS = [
  { id: 0, name: 'Primary' },
  { id: 1, name: 'gauntlet' },
  { id: 2, name: 'admin' },
] as any;

const baseTrigger = (over: Partial<TimerTrigger>): TimerTrigger => ({
  id: 't1',
  name: 'Daily',
  cronExpression: '0 */6 * * *',
  responseType: 'text',
  response: 'hi',
  channels: [0],
  enabled: true,
  ...over,
});

function renderEditor(trigger: TimerTrigger) {
  const onChange = vi.fn();
  const utils = render(
    <TimerTriggerEditor
      trigger={trigger}
      onChange={onChange}
      errors={{}}
      availableScripts={[]}
      channels={CHANNELS}
    />,
  );
  return { onChange, ...utils };
}

const box = (c: HTMLElement, id: string) => c.querySelector<HTMLInputElement>(`#${id}`);

describe('TimerTriggerEditor multi-channel (#6230)', () => {
  it('renders one checkbox per channel and checks the selected ones', () => {
    const { container } = renderEditor(baseTrigger({ channels: [0, 2] }));
    expect(box(container, 'timer-channel-0-t1')?.checked).toBe(true);
    expect(box(container, 'timer-channel-1-t1')?.checked).toBe(false);
    expect(box(container, 'timer-channel-2-t1')?.checked).toBe(true);
  });

  it('adds a channel to the array when its box is checked', () => {
    const { container, onChange } = renderEditor(baseTrigger({ channels: [0] }));
    fireEvent.click(box(container, 'timer-channel-1-t1')!);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ channels: [0, 1], channel: undefined }));
  });

  it('removes a channel when its box is unchecked', () => {
    const { container, onChange } = renderEditor(baseTrigger({ channels: [0, 2] }));
    fireEvent.click(box(container, 'timer-channel-0-t1')!);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ channels: [2] }));
  });

  it('a text timer has no "no mesh output" box', () => {
    const { container } = renderEditor(baseTrigger({ responseType: 'text' }));
    expect(box(container, 'timer-channel-none-t1')).toBeNull();
  });

  it('a script timer offers the exclusive "no mesh output" box', () => {
    const { container, onChange } = renderEditor(baseTrigger({ responseType: 'script', scriptPath: '/data/scripts/x.sh', channels: [0] }));
    const none = box(container, 'timer-channel-none-t1');
    expect(none).not.toBeNull();
    fireEvent.click(none!);
    // Checking none replaces the selection with ['none'] (no mesh output).
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ channels: ['none'] }));
  });

  it('shows none checked and disables channel boxes when none is selected', () => {
    const { container } = renderEditor(baseTrigger({ responseType: 'script', scriptPath: '/data/scripts/x.sh', channels: ['none'] }));
    expect(box(container, 'timer-channel-none-t1')?.checked).toBe(true);
    expect(box(container, 'timer-channel-0-t1')?.disabled).toBe(true);
  });
});
