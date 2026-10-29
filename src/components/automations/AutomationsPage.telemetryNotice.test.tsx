/**
 * AutomationsPage — one-time notice that telemetry automations now fire.
 *
 * trigger.telemetry never fired before (no ingest path emitted the event), so
 * saved telemetry automations come alive on upgrade. The page lists them once,
 * with the once-per-node-per-hour floor, until the user dismisses it.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AutomationsPage from './AutomationsPage';
import { TELEMETRY_TRIGGER_NOTICE_KEY, usesTelemetryTrigger } from './telemetryNoticeHelpers';

vi.mock('../../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), setBaseUrl: vi.fn() },
}));

import apiService from '../../services/api';

const mockedGet = apiService.get as unknown as ReturnType<typeof vi.fn>;

const row = (id: string, name: string, trigger: string, enabled = true) => ({
  id, name, description: null, enabled,
  config: JSON.stringify({ version: 1, nodes: [{ id: 't', type: trigger, params: {} }], edges: [] }),
  createdAt: 1, updatedAt: 1,
});

function seed(rows: unknown[]) {
  mockedGet.mockImplementation((url: string) => Promise.resolve(url === '/api/automations' ? rows : []));
}

beforeEach(() => { mockedGet.mockReset(); localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

const renderPage = () => render(<MemoryRouter><AutomationsPage /></MemoryRouter>);

describe('telemetry trigger notice', () => {
  it('lists saved telemetry automations, including disabled ones, and states the hourly floor', async () => {
    seed([
      row('a', 'Low battery alert', 'trigger.telemetry'),
      row('b', 'Noise watch', 'trigger.telemetry', false),
      row('c', 'Nightly reboot', 'trigger.schedule'),
    ]);
    renderPage();
    const notice = await screen.findByTestId('telemetry-trigger-notice');
    expect(notice.textContent).toContain('Low battery alert');
    expect(notice.textContent).toContain('Noise watch');
    expect(notice.textContent).toContain('(disabled)');
    expect(notice.textContent).not.toContain('Nightly reboot');
    expect(notice.textContent).toContain('once per node per hour');
  });

  it('stays hidden when no automation uses the telemetry trigger', async () => {
    seed([row('c', 'Nightly reboot', 'trigger.schedule')]);
    renderPage();
    await screen.findAllByText('Nightly reboot');
    expect(screen.queryByTestId('telemetry-trigger-notice')).toBeNull();
  });

  it('dismisses for good', async () => {
    seed([row('a', 'Low battery alert', 'trigger.telemetry')]);
    const { unmount } = renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Got it' }));
    expect(screen.queryByTestId('telemetry-trigger-notice')).toBeNull();
    expect(localStorage.getItem(TELEMETRY_TRIGGER_NOTICE_KEY)).toBe('1');
    unmount();

    renderPage();
    await screen.findAllByText('Low battery alert');
    expect(screen.queryByTestId('telemetry-trigger-notice')).toBeNull();
  });

  it('usesTelemetryTrigger tolerates bad config', () => {
    expect(usesTelemetryTrigger('not json')).toBe(false);
    expect(usesTelemetryTrigger('{}')).toBe(false);
  });
});
