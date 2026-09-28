/**
 * @vitest-environment jsdom
 *
 * #5424 follow-up: every OTA call names the selected source, so the server
 * disconnects and reconnects that source's node instead of the primary's.
 * An update running on a different source is reported, not shown as this
 * page's wizard.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  sourceId: 'src-b' as string | null,
  pollData: {
    connection: { connected: true, nodeResponsive: true },
    config: {
      localNodeInfo: { nodeId: '!9ea3e00c', nodeNum: 123 },
      meshtasticNodeIp: '10.0.0.2',
      meshtasticTcpPort: 4403,
      meshtasticSourceType: 'meshtastic_tcp',
      deviceMetadata: { firmwareVersion: '2.7.19' },
    },
    nodes: [] as unknown[],
  },
  status: {
    state: 'awaiting-confirm',
    step: 'preflight',
    message: 'Ready to begin',
    logs: [] as string[],
    preflightInfo: {},
    sourceId: 'src-b' as string | undefined,
  },
  csrfFetch: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : _key,
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey: unknown[] }) => {
    const key = JSON.stringify(opts.queryKey);
    if (key === JSON.stringify(['firmware', 'status']))
      return { data: { success: true, status: h.status, channel: 'stable', customUrl: '', lastChecked: null } };
    if (key === JSON.stringify(['firmware', 'releases']))
      return { data: { success: true, releases: [], channel: 'stable' } };
    if (key === JSON.stringify(['firmware', 'backups'])) return { data: { success: true, backups: [] } };
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
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../hooks/usePoll', () => ({ usePoll: () => ({ data: h.pollData }) }));
vi.mock('../../contexts/DataContext', () => ({ useData: () => ({ setConnectionStatus: vi.fn() }) }));
vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: h.sourceId, sourceName: 'B' }),
}));

import FirmwareUpdateSection from './FirmwareUpdateSection';

function bodyOf(fragment: string): Record<string, unknown> {
  const call = h.csrfFetch.mock.calls.find(([url]) => String(url).includes(fragment))!;
  return JSON.parse(call[1].body as string);
}

beforeEach(() => {
  h.csrfFetch.mockReset();
  h.csrfFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
  h.sourceId = 'src-b';
  h.status.state = 'awaiting-confirm';
  h.status.sourceId = 'src-b';
});

describe('FirmwareUpdateSection — OTA calls carry the selected sourceId (#5424 follow-up)', () => {
  it('confirm sends the sourceId', async () => {
    render(<FirmwareUpdateSection baseUrl="" />);
    fireEvent.click(screen.getByText('Confirm & Proceed'));
    await waitFor(() =>
      expect(h.csrfFetch).toHaveBeenCalledWith(expect.stringContaining('/update/confirm'), expect.anything()),
    );
    expect(bodyOf('/update/confirm').sourceId).toBe('src-b');
  });

  it('cancel sends the sourceId', async () => {
    render(<FirmwareUpdateSection baseUrl="" />);
    fireEvent.click(screen.getByText('Cancel Update'));
    await waitFor(() =>
      expect(h.csrfFetch).toHaveBeenCalledWith(expect.stringContaining('/update/cancel'), expect.anything()),
    );
    expect(bodyOf('/update/cancel').sourceId).toBe('src-b');
  });

  it('omits sourceId outside a SourceProvider (legacy single-source)', async () => {
    h.sourceId = null;
    render(<FirmwareUpdateSection baseUrl="" />);
    fireEvent.click(screen.getByText('Confirm & Proceed'));
    await waitFor(() =>
      expect(h.csrfFetch).toHaveBeenCalledWith(expect.stringContaining('/update/confirm'), expect.anything()),
    );
    expect(bodyOf('/update/confirm')).not.toHaveProperty('sourceId');
  });

  it("shows a notice instead of another source's wizard", () => {
    h.status.sourceId = 'src-a';
    render(<FirmwareUpdateSection baseUrl="" />);
    expect(screen.getByText(/A firmware update is running on another source/)).toBeTruthy();
    expect(screen.queryByText('Confirm & Proceed')).toBeNull();
  });
});
