/**
 * @vitest-environment jsdom
 *
 * #5423: when the board being flashed shares its hw model with other release
 * builds (HELTEC_V4 → heltec-v4, sibling heltec-v4-tft), the wizard shows a
 * prominent warning at the confirm step, before the user confirms flashing.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const HELTEC_V4_WARNING = {
  code: 'OTA_SIBLING_BUILD',
  board: 'heltec-v4',
  boardLabel: 'heltec-v4 (OLED)',
  sibling: 'heltec-v4-tft',
  siblingLabel: 'Heltec V4 TFT',
  message: 'server copy',
};

const h = vi.hoisted(() => ({
  pollData: {
    connection: { connected: true, nodeResponsive: true },
    config: {
      localNodeInfo: { nodeId: '!9ea3e00c', nodeNum: 123 },
      meshtasticNodeIp: '1.2.3.4',
      meshtasticSourceType: 'meshtastic_tcp',
      deviceMetadata: { firmwareVersion: '2.7.26' },
    },
    nodes: [] as unknown[],
  },
  statusResponse: {
    success: true,
    status: {
      state: 'awaiting-confirm',
      step: 'preflight',
      message: 'Preflight complete',
      logs: [] as string[],
      preflightInfo: { gatewayIp: '1.2.3.4', boardName: 'heltec-v4' },
      warnings: [] as unknown[],
    } as Record<string, unknown>,
    channel: 'stable',
    customUrl: '',
    lastChecked: null,
  },
}));

// i18next-style interpolation so the rendered copy can be asserted.
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey: unknown[] }) => {
    const key = JSON.stringify(opts.queryKey);
    if (key === JSON.stringify(['firmware', 'status'])) return { data: h.statusResponse };
    if (key === JSON.stringify(['firmware', 'releases']))
      return { data: { success: true, releases: [], channel: 'stable' } };
    if (key === JSON.stringify(['firmware', 'backups']))
      return { data: { success: true, backups: [] } };
    return { data: undefined };
  },
  useQueryClient: () => ({
    getQueryData: () => undefined,
    invalidateQueries: vi.fn(),
    removeQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));

vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => vi.fn() }));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../hooks/usePoll', () => ({ usePoll: () => ({ data: h.pollData }) }));
vi.mock('../../contexts/DataContext', () => ({
  useData: () => ({ setConnectionStatus: vi.fn() }),
}));

import FirmwareUpdateSection from './FirmwareUpdateSection';

beforeEach(() => {
  h.statusResponse.status = {
    state: 'awaiting-confirm',
    step: 'preflight',
    message: 'Preflight complete',
    logs: [],
    preflightInfo: { gatewayIp: '1.2.3.4', boardName: 'heltec-v4' },
    warnings: [],
  };
});

describe('FirmwareUpdateSection — sibling-build warning (#5423)', () => {
  it('shows the warning at the preflight confirm step, next to Confirm & Proceed', () => {
    h.statusResponse.status.warnings = [HELTEC_V4_WARNING];
    render(<FirmwareUpdateSection baseUrl="" />);

    const alert = screen.getByTestId('ota-sibling-warning');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain(
      'This will flash heltec-v4 (OLED). If your node is a Heltec V4 TFT, cancel and use a custom ' +
        'firmware URL or upload the heltec-v4-tft .bin instead.',
    );
    expect(screen.getByText('Confirm & Proceed')).toBeTruthy();
  });

  it('still shows it at the last confirm before flashing (extract step)', () => {
    h.statusResponse.status.step = 'extract';
    h.statusResponse.status.warnings = [HELTEC_V4_WARNING];
    render(<FirmwareUpdateSection baseUrl="" />);
    expect(screen.getByTestId('ota-sibling-warning')).toBeTruthy();
  });

  it('shows nothing for a board without sibling builds', () => {
    render(<FirmwareUpdateSection baseUrl="" />);
    expect(screen.queryByTestId('ota-sibling-warning')).toBeNull();
  });
});
