/**
 * @vitest-environment jsdom
 *
 * Issue #5424: the OTA wizard must target the selected source's host AND its
 * configured TCP port. The poll `config` is already scoped to the selected
 * source; the section used to send only `meshtasticNodeIp`, so the meshtastic
 * CLI fell back to port 4403.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  pollData: {
    connection: { connected: true, nodeResponsive: true },
    config: {
      localNodeInfo: { nodeId: '!9ea3e00c', nodeNum: 123 },
      meshtasticNodeIp: '10.0.0.5',
      meshtasticTcpPort: 5000 as number | undefined,
      meshtasticSourceType: 'meshtastic_tcp',
      deviceMetadata: { firmwareVersion: '2.5.0' },
    },
    nodes: [] as unknown[],
  },
  statusResponse: {
    success: true,
    status: {
      state: 'awaiting-confirm',
      step: 'preflight',
      message: 'Ready to begin',
      logs: [] as string[],
      // No gatewayIp here, so the confirm call falls back to the section's
      // own gateway, which is what this suite checks.
      preflightInfo: {},
    },
    channel: 'stable',
    customUrl: '',
    lastChecked: null,
  },
  csrfFetch: vi.fn(),
  showToast: vi.fn(),
}));

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

vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => h.csrfFetch }));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock('../../hooks/usePoll', () => ({ usePoll: () => ({ data: h.pollData }) }));
vi.mock('../../contexts/DataContext', () => ({
  useData: () => ({ setConnectionStatus: vi.fn() }),
}));

import FirmwareUpdateSection from './FirmwareUpdateSection';

const okResp = { ok: true, status: 200, json: async () => ({ success: true }) };

async function confirmBody(): Promise<Record<string, unknown>> {
  render(<FirmwareUpdateSection baseUrl="" />);
  fireEvent.click(screen.getByText('Confirm & Proceed'));
  await waitFor(() =>
    expect(h.csrfFetch).toHaveBeenCalledWith(expect.stringContaining('/update/confirm'), expect.anything()),
  );
  const call = h.csrfFetch.mock.calls.find(([url]) => String(url).includes('/update/confirm'))!;
  return JSON.parse(call[1].body as string);
}

beforeEach(() => {
  h.csrfFetch.mockReset();
  h.csrfFetch.mockResolvedValue(okResp);
  h.showToast.mockReset();
});

describe('FirmwareUpdateSection — gateway carries the source TCP port (#5424)', () => {
  it('sends host:port when the selected source uses a custom TCP port', async () => {
    h.pollData.config.meshtasticNodeIp = '10.0.0.5';
    h.pollData.config.meshtasticTcpPort = 5000;
    const body = await confirmBody();
    expect(body.gatewayIp).toBe('10.0.0.5:5000');
  });

  it('sends the bare host when the source uses the default 4403 port', async () => {
    h.pollData.config.meshtasticNodeIp = '10.0.0.5';
    h.pollData.config.meshtasticTcpPort = 4403;
    const body = await confirmBody();
    expect(body.gatewayIp).toBe('10.0.0.5');
  });

  it('sends the bare host when no port is configured', async () => {
    h.pollData.config.meshtasticNodeIp = 'node.lan';
    h.pollData.config.meshtasticTcpPort = undefined;
    const body = await confirmBody();
    expect(body.gatewayIp).toBe('node.lan');
  });

  it('shows the port next to the IP in the gateway summary', () => {
    h.pollData.config.meshtasticNodeIp = '10.0.0.5';
    h.pollData.config.meshtasticTcpPort = 5000;
    render(<FirmwareUpdateSection baseUrl="" />);
    expect(screen.getAllByText(/10\.0\.0\.5:5000/).length).toBeGreaterThan(0);
  });
});
