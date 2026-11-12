/**
 * @vitest-environment jsdom
 *
 * MeshCore Time Sync / Remote Telemetry sections (#4173 review M9 + L25).
 *
 * The per-node tables used the global `data-table` class, which has no CSS,
 * and had no scroll wrapper, so at 390px Save/Disable sat off-screen. The
 * action cell was `display: flex` on the <td> itself, which drops it out of
 * table layout. The headers were a bare right-aligned <h2> unlike every
 * sibling section, which use the shared ConfigSection card.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => fetchMock }));

import { MeshCoreTimeSyncSection } from './MeshCoreTimeSyncSection';
import { MeshCoreRemoteTelemetrySection } from './MeshCoreRemoteTelemetrySection';

const node = {
  publicKey: 'ab'.repeat(32),
  name: 'Repeater One',
  intervalMinutes: 60,
  lastSyncAt: null,
  lastRequestAt: null,
  lastSuccessAt: null,
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { nodes: [node] } }) });
});

describe.each([
  ['Time Sync', MeshCoreTimeSyncSection],
  ['Remote Telemetry', MeshCoreRemoteTelemetrySection],
])('%s section layout', (title, Section) => {
  it('wraps the table in its own scroll container and keeps the action cell a table cell', async () => {
    const { container } = render(<Section baseUrl="" sourceId="src-1" />);
    await waitFor(() => expect(screen.getByText('Repeater One')).toBeTruthy());

    const table = container.querySelector('table') as HTMLTableElement;
    expect(table.classList.contains('data-table')).toBe(false);
    // The wrapper, not the whole automations view, owns the sideways scroll.
    expect(table.parentElement?.tagName).toBe('DIV');
    expect(table.parentElement?.className).toMatch(/scroll/);

    const saveCell = screen.getByRole('button', { name: 'Save' }).closest('td') as HTMLTableCellElement;
    expect(saveCell.style.display).toBe('');
    expect(screen.getByRole('button', { name: 'Disable' }).closest('td')).toBe(saveCell);
  });

  it('uses the shared section header like its sibling sections', async () => {
    const { container } = render(<Section baseUrl="" sourceId="src-1" />);
    await waitFor(() => expect(screen.getByText('Repeater One')).toBeTruthy());
    const heading = screen.getByRole('heading', { level: 2, name: title });
    // ConfigSection keeps the global class on the header bar, not on the <h2>.
    expect(heading.classList.contains('automation-section-header')).toBe(false);
    expect(container.querySelector('.automation-section-header')).not.toBeNull();
  });
});
