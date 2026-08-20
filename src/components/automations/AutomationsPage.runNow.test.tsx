/**
 * AutomationsPage — "Run Now" button (#4827).
 *
 * Run Now fires an automation's REAL actions immediately (mesh sends, reboots,
 * notifications), unlike the safe "Test" dry-run. Because it is destructive it
 * MUST be gated behind an explicit confirmation. These prove the button asks for
 * confirmation first, does nothing when the user cancels, and only then calls the
 * live-execution API.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AutomationsPage from './AutomationsPage';

vi.mock('../../services/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    setBaseUrl: vi.fn(),
    runAutomationNow: vi.fn(),
  },
}));

import apiService from '../../services/api';

const mockedGet = apiService.get as unknown as ReturnType<typeof vi.fn>;
const mockedRunNow = apiService.runAutomationNow as unknown as ReturnType<typeof vi.fn>;

const AUTOMATION = {
  id: 'auto-1',
  name: 'Nightly reboot',
  description: null,
  enabled: true,
  config: JSON.stringify({ nodes: [{ id: 't1', type: 'trigger.schedule', params: { cron: '0 3 * * *' } }], edges: [] }),
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

beforeEach(() => {
  mockedGet.mockReset();
  mockedRunNow.mockReset();
  mockedGet.mockImplementation((url: string) => {
    if (url === '/api/automations') return Promise.resolve([AUTOMATION]);
    return Promise.resolve([]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Open the editor for the seeded automation and wait for the Run now button. */
async function openEditor() {
  render(<MemoryRouter><AutomationsPage /></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  return screen.findByRole('button', { name: /Run now/i });
}

describe('AutomationsPage — Run Now', () => {
  it('does NOT fire when the user cancels the confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const runNowBtn = await openEditor();
    await userEvent.click(runNowBtn);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mockedRunNow).not.toHaveBeenCalled();
  });

  it('fires the live-execution API only after the user confirms', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockedRunNow.mockResolvedValue({ ran: true, status: 'completed', actions: [{ nodeId: 'a1', ok: true }] });

    const runNowBtn = await openEditor();
    await userEvent.click(runNowBtn);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mockedRunNow).toHaveBeenCalledTimes(1);
    expect(mockedRunNow).toHaveBeenCalledWith('auto-1');
    // The outcome is surfaced to the user.
    expect(await screen.findByText(/Fired: completed/i)).toBeInTheDocument();
  });

  it('reports a cooldown suppression instead of claiming success', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockedRunNow.mockResolvedValue({ ran: false, reason: 'cooldown', detail: 'cooldown active — 30s remaining (automation)' });

    const runNowBtn = await openEditor();
    await userEvent.click(runNowBtn);

    expect(await screen.findByText(/Did not fire: cooldown active/i)).toBeInTheDocument();
  });
});
