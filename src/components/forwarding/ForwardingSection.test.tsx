/**
 * @vitest-environment jsdom
 *
 * ForwardingSection (#5446) — rule rendering, per-rule toggle, channel
 * airtime warning, save payload, and receive-only (read-only) mode.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const { hasPermissionMock } = vi.hoisted(() => ({ hasPermissionMock: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: hasPermissionMock }),
}));

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

const { saveBarCapture } = vi.hoisted(() => ({
  saveBarCapture: { current: null as null | { hasChanges: boolean; onSave: () => Promise<void> } },
}));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: { hasChanges: boolean; onSave: () => Promise<void> }) => {
    saveBarCapture.current = options;
  },
}));

import { ForwardingSection } from './ForwardingSection';

const RULES = [
  {
    id: 'r1', name: 'DMs to phone', enabled: true,
    match: { isDM: true }, forwardTo: { destinationNodeId: '!0000beef' }, prefix: '{from}: ',
  },
  {
    id: 'r2', name: 'Ops bridge', enabled: false,
    match: { channel: 1 }, forwardTo: { channel: 2 }, prefix: '',
  },
];

const CHANNELS = [{ index: 0, name: 'Primary' }, { index: 1, name: 'Ops' }, { index: 2, name: 'Gauntlet' }];
const NODES = [{ id: '!0000beef', label: 'Phone (!0000beef)' }];

function renderSection(receiveOnly = false) {
  return render(
    <ForwardingSection baseUrl="" sourceId="src1" channels={CHANNELS} nodes={NODES} receiveOnly={receiveOnly} />,
  );
}

describe('ForwardingSection', () => {
  beforeEach(() => {
    hasPermissionMock.mockReset().mockReturnValue(true);
    showToastMock.mockReset();
    saveBarCapture.current = null;
    csrfFetchMock.mockReset().mockImplementation((_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body ?? '{}');
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { rules: body.rules } }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { rules: RULES } }) });
    });
  });

  it('loads the source-scoped rules and renders each one', async () => {
    renderSection();
    expect(await screen.findByDisplayValue('DMs to phone')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Ops bridge')).toBeInTheDocument();
    expect(csrfFetchMock.mock.calls[0][0]).toBe('/api/sources/src1/forwarding');
    expect(screen.getAllByTestId('forwarding-rule')).toHaveLength(2);
  });

  it('shows the shared-airtime warning only next to channel targets', async () => {
    renderSection();
    await screen.findByDisplayValue('Ops bridge');
    const warnings = screen.getAllByRole('note');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toHaveTextContent(/shared airtime/i);
  });

  it('toggles a rule and saves the new state', async () => {
    renderSection();
    await screen.findByDisplayValue('Ops bridge');
    const toggle = screen.getByLabelText('Enable Ops bridge') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));
    await saveBarCapture.current!.onSave();
    const post = csrfFetchMock.mock.calls.find(c => c[1]?.method === 'POST');
    expect(post).toBeDefined();
    const sent = JSON.parse(post![1].body);
    expect(sent.rules.find((r: { id: string }) => r.id === 'r2').enabled).toBe(true);
    expect(showToastMock).toHaveBeenCalledWith('Settings saved', 'success');
  });

  it('blocks save with a toast when a new rule is incomplete', async () => {
    renderSection();
    await screen.findByDisplayValue('Ops bridge');
    fireEvent.click(screen.getByText('Add forwarding rule'));
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));
    await saveBarCapture.current!.onSave();
    expect(csrfFetchMock.mock.calls.some(c => c[1]?.method === 'POST')).toBe(false);
    expect(showToastMock).toHaveBeenCalledWith(expect.stringMatching(/name is required/), 'error');
  });

  it('a newly added rule starts disabled, so it cannot send until armed', async () => {
    renderSection();
    await screen.findByDisplayValue('Ops bridge');
    fireEvent.click(screen.getByText('Add forwarding rule'));
    const cards = screen.getAllByTestId('forwarding-rule');
    expect(cards).toHaveLength(3);
    const toggle = cards[2].querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it('uses the shared settings form controls', async () => {
    renderSection();
    await screen.findByDisplayValue('Ops bridge');
    const card = screen.getAllByTestId('forwarding-rule')[0];
    const controls = card.querySelectorAll('select, input[type="text"]');
    expect(controls.length).toBeGreaterThan(0);
    controls.forEach(c => expect(c.classList.contains('setting-input')).toBe(true));
  });

  it('switching a target to Channel pre-selects no channel and blocks saving until one is chosen', async () => {
    renderSection();
    await screen.findByDisplayValue('DMs to phone');
    const card = screen.getAllByTestId('forwarding-rule')[0];
    const kind = card.querySelector('select[aria-label="Target type"]') as HTMLSelectElement;
    fireEvent.change(kind, { target: { value: 'channel' } });

    const channelSelect = card.querySelector('select[aria-label="Channel"]') as HTMLSelectElement;
    expect(channelSelect.value).toBe('');
    expect(channelSelect.selectedOptions[0]).toHaveTextContent('Choose a channel...');

    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));
    await saveBarCapture.current!.onSave();
    expect(csrfFetchMock.mock.calls.some(c => c[1]?.method === 'POST')).toBe(false);
    expect(showToastMock).toHaveBeenCalledWith(expect.stringMatching(/choose a channel/), 'error');

    fireEvent.change(channelSelect, { target: { value: '2' } });
    await saveBarCapture.current!.onSave();
    const post = csrfFetchMock.mock.calls.find(c => c[1]?.method === 'POST');
    expect(JSON.parse(post![1].body).rules[0].forwardTo).toEqual({ channel: 2 });
  });

  it('meshcore variant uses the MeshCore control classes', async () => {
    render(
      <ForwardingSection baseUrl="" sourceId="src1" channels={CHANNELS} nodes={NODES} controlVariant="meshcore" />,
    );
    await screen.findByDisplayValue('DMs to phone');
    const card = screen.getAllByTestId('forwarding-rule')[0];
    card.querySelectorAll('input[type="text"]').forEach(c => {
      expect(c.classList.contains('meshcore-input')).toBe(true);
      expect(c.classList.contains('setting-input')).toBe(false);
    });
    card.querySelectorAll('select').forEach(c => {
      expect(c.classList.contains('meshcore-select')).toBe(true);
      expect(c.classList.contains('setting-input')).toBe(false);
    });
  });

  it('receive-only: shows rules read-only with the paused note', async () => {
    renderSection(true);
    const name = (await screen.findByDisplayValue('DMs to phone')) as HTMLInputElement;
    expect(name).toBeDisabled();
    expect(screen.getByLabelText('Enable DMs to phone')).toBeDisabled();
    expect(screen.getByText('Add forwarding rule').closest('button')).toBeDisabled();
    expect(screen.getAllByLabelText('Delete rule').every(b => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent(/cannot transmit/i);
  });

  it('not receive-only: no paused note and inputs editable', async () => {
    renderSection(false);
    const name = await screen.findByDisplayValue('DMs to phone');
    expect(name).not.toBeDisabled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('read-only without automation:write on this source', async () => {
    hasPermissionMock.mockReturnValue(false);
    renderSection(false);
    const name = await screen.findByDisplayValue('DMs to phone');
    expect(name).toBeDisabled();
    expect(hasPermissionMock).toHaveBeenCalledWith('automation', 'write', { sourceId: 'src1' });
  });
});
