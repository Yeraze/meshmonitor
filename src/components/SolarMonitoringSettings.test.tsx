/**
 * @vitest-environment jsdom
 *
 * Open-Meteo settings block (#6523): usage table and free-tier warning.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

const get = vi.fn();
vi.mock('../services/api', () => ({ default: { get: (...args: unknown[]) => get(...args) } }));
vi.mock('react-i18next', () => {
  const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key);
  return { useTranslation: () => ({ t }) };
});

import SolarMonitoringSettings from './SolarMonitoringSettings';

const usage = {
  activeNodes: 1200,
  freeDailyBudget: 9000,
  cellsByGrid: { '0.05': 1100, '0.1': 900, '0.25': 400, '0.5': 120, '1': 30 },
};

function renderBlock(props: Partial<React.ComponentProps<typeof SolarMonitoringSettings>> = {}) {
  return render(
    <SolarMonitoringSettings
      isAdmin
      apiToken=""
      gridSize="0.1"
      refreshHours="1"
      onApiTokenChange={vi.fn()}
      onGridSizeChange={vi.fn()}
      onRefreshHoursChange={vi.fn()}
      {...props}
    />,
  );
}

describe('SolarMonitoringSettings', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ success: true, data: usage });
  });

  it('shows calls/day per grid at the selected interval and marks the selected grid', async () => {
    renderBlock();
    const table = await screen.findByTestId('solar-usage-estimate');
    expect(get).toHaveBeenCalledWith('/api/solar/usage');
    const selected = within(table).getAllByRole('row').find(r => r.getAttribute('aria-current') === 'true');
    // 900 cells refreshed hourly = 21,600 calls/day.
    expect(selected?.textContent).toContain('0.1°');
    expect(selected?.textContent).toContain('21,600');
  });

  it('warns when the free tier cannot cover the choice and no key is set', async () => {
    renderBlock();
    const warning = await screen.findByTestId('solar-budget-warning');
    // Free tier at a 1 h refresh covers 375 cells.
    expect(warning.textContent).toContain('"cap":"375"');
  });

  it('does not warn with an API key or a choice under budget', async () => {
    const { unmount } = renderBlock({ apiToken: 'abc' });
    await screen.findByTestId('solar-usage-estimate');
    expect(screen.queryByTestId('solar-budget-warning')).toBeNull();
    unmount();

    renderBlock({ gridSize: '1', refreshHours: '3' });
    await screen.findByTestId('solar-usage-estimate');
    expect(screen.queryByTestId('solar-budget-warning')).toBeNull();
  });

  it('skips the admin-only usage read for non-admins', async () => {
    renderBlock({ isAdmin: false });
    await waitFor(() => expect(screen.getByText('settings.solar_privacy_note')).toBeTruthy());
    expect(get).not.toHaveBeenCalled();
  });
});
