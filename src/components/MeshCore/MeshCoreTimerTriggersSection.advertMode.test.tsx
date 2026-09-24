/**
 * @vitest-environment jsdom
 *
 * MeshCoreTimerTriggersSection — advert reach per timer trigger.
 *
 * - An advert trigger saved before the field existed (no advertMode) shows
 *   Flood, which is what the server runs.
 * - A new trigger is created with zero_hop.
 * - Switching an older text trigger to "Send advert" picks zero_hop.
 * - The chosen mode is saved with the trigger.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

const { saveBarCapture } = vi.hoisted(() => ({ saveBarCapture: { current: null as null | { onSave: () => Promise<void>; hasChanges: boolean } } }));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: { onSave: () => Promise<void>; hasChanges: boolean }) => {
    saveBarCapture.current = options;
  },
}));

import { MeshCoreTimerTriggersSection } from './MeshCoreTimerTriggersSection';

const base = {
  enabled: true,
  scheduleType: 'cron',
  cronExpression: '0 */6 * * *',
  destination: 'channel',
  channelIndex: 0,
  scopeMode: 'inherit',
  scopeName: '',
};

function mockFetch(triggers: unknown[]) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/automation/timers') && init?.method === 'POST') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
    }
    if (url.includes('/automation/timers')) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { triggers } }) });
    }
    if (url.includes('/channels/all')) {
      return Promise.resolve({ ok: true, json: async () => ([{ id: 0, name: 'Primary' }]) });
    }
    if (url.includes('/api/scripts')) {
      return Promise.resolve({ ok: true, json: async () => ({ scripts: [] }) });
    }
    if (url.includes('/contacts')) {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: [] }) });
    }
    return Promise.resolve({ ok: false, json: async () => ({}) });
  });
}

/** The per-trigger "Action" <select> (the one offering an advert option). */
const actionSelects = () => screen.getAllByRole('combobox')
  .filter((el) => el.querySelector('option[value="advert"]')) as HTMLSelectElement[];

async function savedTriggers(): Promise<Array<Record<string, unknown>>> {
  await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));
  await act(async () => { await saveBarCapture.current!.onSave(); });
  const post = csrfFetchMock.mock.calls.find(([url, init]) =>
    String(url).includes('/automation/timers') && (init as RequestInit | undefined)?.method === 'POST');
  expect(post).toBeDefined();
  return JSON.parse((post![1] as RequestInit).body as string).triggers;
}

describe('MeshCoreTimerTriggersSection advert mode', () => {
  beforeEach(() => {
    saveBarCapture.current = null;
  });

  it('shows a legacy advert trigger (no advertMode) as flood, with the warning', async () => {
    csrfFetchMock.mockReset().mockImplementation(mockFetch([{ ...base, id: 'a1', name: 'Old advert', responseType: 'advert' }]));
    render(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" />);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Flood (whole mesh)' })).toBeChecked());
    expect(screen.getByRole('note')).toHaveTextContent(/at most once per hour per source/);
  });

  it('switching an older text trigger to advert picks zero-hop, and the choice is saved', async () => {
    csrfFetchMock.mockReset().mockImplementation(mockFetch([{ ...base, id: 't1', name: 'Text', responseType: 'text', response: 'hi' }]));
    render(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" />);
    await waitFor(() => expect(actionSelects()).toHaveLength(1));
    fireEvent.change(actionSelects()[0], { target: { value: 'advert' } });
    expect(screen.getByRole('radio', { name: 'Zero-hop (nearby nodes only)' })).toBeChecked();

    const triggers = await savedTriggers();
    expect(triggers[0]).toMatchObject({ id: 't1', responseType: 'advert', advertMode: 'zero_hop' });
  });

  it('a new trigger is created with zero_hop', async () => {
    csrfFetchMock.mockReset().mockImplementation(mockFetch([]));
    render(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" />);
    const nameInputs = await screen.findAllByPlaceholderText('Trigger name');
    fireEvent.change(nameInputs[nameInputs.length - 1], { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add trigger' }));

    const triggers = await savedTriggers();
    expect(triggers[0]).toMatchObject({ name: 'New', advertMode: 'zero_hop' });
  });

  it('saves a switch from flood to zero-hop on an existing advert trigger', async () => {
    csrfFetchMock.mockReset().mockImplementation(mockFetch([{ ...base, id: 'a1', name: 'Old advert', responseType: 'advert' }]));
    render(<MeshCoreTimerTriggersSection baseUrl="" sourceId="src1" />);
    const zero = await screen.findByRole('radio', { name: 'Zero-hop (nearby nodes only)' });
    fireEvent.click(zero);
    const triggers = await savedTriggers();
    expect(triggers[0]).toMatchObject({ id: 'a1', advertMode: 'zero_hop' });
  });
});
