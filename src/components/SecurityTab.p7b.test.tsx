/**
 * @vitest-environment jsdom
 *
 * Security tab, P7b (#6281): shared scanner / export / digest / rate / clock
 * sections on both protocols, per-source digest saves, and the draft-only
 * notification button with its guards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});

let perms: Record<string, boolean> = {};
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    hasPermission: (resource: string, action: string) => perms[`${resource}:${action}`] === true,
  }),
}));
vi.mock('../hooks/useResolvedSourceId', () => ({ useResolvedSourceId: () => 'src-1' }));

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  download: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(m: string, status: number) { super(m); this.status = status; }
  },
}));
vi.mock('../services/api', () => ({ default: { get: h.get, post: h.post, download: h.download }, ApiError: h.ApiError }));

import { SecurityTab } from './SecurityTab';

const nowSec = Math.floor(Date.now() / 1000);
const KEY1 = 'ab'.repeat(32);
const KEY2 = 'cd'.repeat(32);
const KEY3 = 'ef'.repeat(32);

const mcNode = (over: Record<string, unknown>) => ({
  protocol: 'meshcore', nodeNum: 1, shortName: 'N', longName: 'N', lastHeard: nowSec - 60, keyIsLowEntropy: false,
  duplicateKeyDetected: false, isExcessivePackets: false, packetRatePerHour: null, packetRateLastChecked: null,
  isTimeOffsetIssue: false, timeOffsetSeconds: null, advType: 1, hasKnownPath: true, onDevice: true, ...over,
});
const chatty = mcNode({ nodeKey: `mc:${KEY1}`, publicKey: KEY1, longName: 'Chatty', shortName: 'Chatty', isExcessivePackets: true, packetRatePerHour: 44, packetRateLastChecked: nowSec });
const skewed = mcNode({ nodeKey: `mc:${KEY2}`, publicKey: KEY2, longName: 'Skewed', shortName: 'Skewed', isTimeOffsetIssue: true, timeOffsetSeconds: 7200, timeOffsetSource: 'advert' });
const unsetClock = mcNode({ nodeKey: `mc:${KEY3}`, publicKey: KEY3, longName: 'NoRtc', shortName: 'NoRtc', isTimeOffsetIssue: true, timeOffsetSeconds: 800 * 86400 });

function mcIssues(nodes: unknown[], over: Record<string, unknown> = {}) {
  return {
    protocol: 'meshcore', total: nodes.length, lowEntropyCount: 0, duplicateKeyCount: 0,
    excessivePacketsCount: (nodes as any[]).filter(n => n.isExcessivePackets).length,
    timeOffsetCount: (nodes as any[]).filter(n => n.isTimeOffsetIssue).length,
    nodes, topBroadcasters: [{ nodeNum: 1, nodeKey: `mc:${KEY1}`, shortName: null, longName: 'Chatty', packetCount: 44 }],
    thresholds: { packetsPerHour: 30, timeOffsetMinutes: 30 }, packetLogEnabled: true, ...over,
  };
}

const findings = {
  success: true,
  data: {
    pathHashCollisions: { width: 1, countsByWidth: { 1: 0, 2: 0, 3: 0 }, groups: [] },
    signatureFailures: [], nameReuse: [],
    ownKey: { currentKey: 'f'.repeat(64), previousKey: null, detectedAt: null, pkiKeyMismatch: false },
  },
};

function route(issues: unknown, extra: Record<string, unknown> = {}) {
  h.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/security/dead-nodes')) return { nodes: [], count: 0, thresholdDays: 14 };
    if (url.startsWith('/api/security/meshcore/findings')) return findings;
    if (url.startsWith('/api/security/issues')) return issues;
    if (url.startsWith('/api/security/scanner/status')) return { running: true, scanningNow: false, intervalHours: 24, lastScanTime: nowSec - 120 };
    if (url.startsWith('/api/security/key-mismatches')) return { events: [] };
    if (url.startsWith('/api/settings')) return extra.settings ?? {};
    return {};
  });
}

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset().mockResolvedValue({});
  h.download.mockReset();
  perms = { 'security:read': true, 'security:write': true, 'nodes:write': true, 'settings:write': true, 'messages:write': true, 'messages:read': true };
});

describe('MeshCore Security tab (P7b)', () => {
  it('shows scanner, rates, offset, digest, export and top broadcasters', async () => {
    route(mcIssues([chatty, skewed]));
    render(<SecurityTab sourceType="meshcore" sourceId="src-1" deviceType={1} />);
    expect(await screen.findByText('security.scanner_status')).toBeTruthy();
    expect(screen.getByText('Security Digest')).toBeTruthy();
    expect(screen.getByText('security.export')).toBeTruthy();
    expect(screen.getByText('security.top_broadcasters')).toBeTruthy();
    expect(screen.getByText('44', { selector: '.packet-count' })).toBeTruthy();
    expect(screen.getByText(/security\.excessive_packets_count/)).toBeTruthy();
    expect(screen.getByText(/security\.time_offset_count/)).toBeTruthy();
    expect(screen.queryByTestId('security-packet-log-off')).toBeNull();
  });

  it('shows the packet-monitor hint when the packet log is off', async () => {
    route(mcIssues([skewed], { packetLogEnabled: false }));
    render(<SecurityTab sourceType="meshcore" sourceId="src-1" deviceType={1} />);
    expect(await screen.findByTestId('security-packet-log-off')).toBeTruthy();
    expect(screen.getByTestId('security-packet-log-off').textContent).toBe('Enable the MeshCore Packet Monitor to measure rates');
  });

  it('labels a never-set clock', async () => {
    route(mcIssues([unsetClock]));
    render(<SecurityTab sourceType="meshcore" sourceId="src-1" deviceType={1} />);
    expect(await screen.findByText('Clock not set', { selector: '.time-offset-value' })).toBeTruthy();
  });

  it('a 403 on issues shows the access note and stops polling it', async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/security/issues')) throw new h.ApiError('forbidden', 403);
      if (url.startsWith('/api/security/dead-nodes')) return { nodes: [], count: 0, thresholdDays: 14 };
      if (url.startsWith('/api/security/meshcore/findings')) return findings;
      if (url.startsWith('/api/security/scanner/status')) return { running: true, scanningNow: false, intervalHours: 24, lastScanTime: null };
      return {};
    });
    render(<SecurityTab sourceType="meshcore" sourceId="src-1" deviceType={1} />);
    expect(await screen.findByTestId('security-issues-forbidden')).toBeTruthy();
    expect(screen.queryByText('security.scanner_status')).toBeNull();
  });

  it('Run scan now posts the source', async () => {
    route(mcIssues([chatty]));
    render(<SecurityTab sourceType="meshcore" sourceId="src-1" deviceType={1} />);
    fireEvent.click(await screen.findByText('security.run_scan_now'));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/api/security/scanner/scan', { sourceId: 'src-1' }));
  });

  it('exports through the shared menu with the source', async () => {
    route(mcIssues([chatty]));
    render(<SecurityTab sourceType="meshcore" sourceId="src-1" deviceType={1} />);
    fireEvent.click(await screen.findByText('security.export'));
    fireEvent.click(screen.getByText('security.export_as_json'));
    await waitFor(() => expect(h.download).toHaveBeenCalled());
    expect(h.download.mock.calls[0][0]).toBe('/api/security/export?format=json&sourceId=src-1');
  });
});

describe('Security digest card (P7b)', () => {
  it('saves the four per-source keys with ?sourceId and the global keys without', async () => {
    route(mcIssues([]), { settings: { securityDigestEnabled: 'true', securityDigestTime: '07:30', securityDigestAppriseUrl: 'discord://x' } });
    render(<SecurityTab sourceType="meshcore" sourceId="src-1" deviceType={1} />);
    const url = await screen.findByPlaceholderText('discord://webhook_id/webhook_token');
    await waitFor(() => expect((url as HTMLInputElement).value).toBe('discord://x'));
    expect(h.get).toHaveBeenCalledWith('/api/settings?sourceId=src-1');
    fireEvent.change(url, { target: { value: 'discord://y' } });
    fireEvent.click(document.querySelector('.digest-save-btn') as HTMLElement);
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2));
    expect(h.post).toHaveBeenNthCalledWith(1, '/api/settings?sourceId=src-1', {
      securityDigestAppriseUrl: 'discord://y',
      securityDigestReportType: 'summary',
      securityDigestSuppressEmpty: 'true',
      securityDigestFormat: 'text',
    });
    expect(h.post).toHaveBeenNthCalledWith(2, '/api/settings', { securityDigestEnabled: 'true', securityDigestTime: '07:30' });
  });

  it('Send now posts the page source and reports a skipped result', async () => {
    route(mcIssues([]), { settings: { securityDigestAppriseUrl: 'discord://x' } });
    h.post.mockResolvedValue({ success: true, skipped: true, message: 'src-1:skipped' });
    render(<SecurityTab sourceType="meshcore" sourceId="src-1" deviceType={1} />);
    const send = await screen.findByText('Send Now');
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/api/security/digest/send', { sourceId: 'src-1' }));
    expect(await screen.findByText('Skipped: no Apprise URL is set for this source.')).toBeTruthy();
  });
});

describe('notification DM button (P7b)', () => {
  const open = vi.fn();
  beforeEach(() => open.mockReset());
  const renderMc = (nodes: unknown[], props: Record<string, unknown> = {}) => {
    route(mcIssues(nodes));
    return render(<SecurityTab sourceType="meshcore" sourceId="src-1" deviceType={1} onOpenDmWithDraft={open} {...props} />);
  };
  const btns = () => document.querySelectorAll('.send-notification-btn');

  it('opens a draft (never sends) with the packet-rate text', async () => {
    renderMc([chatty]);
    await screen.findByText(/security\.excessive_packets_count/);
    expect(btns()).toHaveLength(1);
    fireEvent.click(btns()[0]);
    expect(open).toHaveBeenCalledWith(`mc:${KEY1}`, 'MeshMonitor: your node sends 44 packets/hr. Please check it.');
    expect(h.post.mock.calls.every(([u]) => !String(u).includes('messages'))).toBe(true);
  });

  it('time-offset text, never-set clock text', async () => {
    renderMc([skewed, unsetClock]);
    await screen.findByText(/security\.time_offset_count/);
    const [first, second] = Array.from(btns());
    fireEvent.click(first);
    fireEvent.click(second);
    expect(open).toHaveBeenNthCalledWith(1, `mc:${KEY2}`, "MeshMonitor: your node's clock is 2h behind. Please set its time.");
    expect(open).toHaveBeenNthCalledWith(2, `mc:${KEY3}`, "MeshMonitor: your node's clock is not set. Please set its time.");
  });

  it('is hidden for a Repeater source, a Repeater/Room target, and without messages:write', async () => {
    const { unmount } = renderMc([chatty], { deviceType: 2 });
    await screen.findByText(/security\.excessive_packets_count/);
    expect(btns()).toHaveLength(0);
    unmount();

    for (const advType of [2, 3]) {
      const r = renderMc([{ ...chatty, advType }]);
      await screen.findByText(/security\.excessive_packets_count/);
      expect(btns()).toHaveLength(0);
      r.unmount();
    }

    perms['messages:write'] = false;
    renderMc([chatty]);
    await screen.findByText(/security\.excessive_packets_count/);
    expect(btns()).toHaveLength(0);
  });

  it('is hidden for an MQTT ingest source', async () => {
    route(mcIssues([chatty]));
    render(<SecurityTab sourceType="meshcore_mqtt" sourceId="src-1" onOpenDmWithDraft={open} />);
    await screen.findByText(/security\.excessive_packets_count/);
    expect(btns()).toHaveLength(0);
  });

  it('warns about flooding when no path is known; disables when the contact is not on the radio', async () => {
    const r = renderMc([{ ...chatty, hasKnownPath: false }]);
    await screen.findByText(/security\.excessive_packets_count/);
    expect(screen.getByTestId('security-flood-warning').textContent).toBe('No known path: this DM will flood the mesh');
    r.unmount();

    renderMc([{ ...chatty, onDevice: false }]);
    await screen.findByText(/security\.excessive_packets_count/);
    const b = btns()[0] as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(screen.queryByTestId('security-flood-warning')).toBeNull();
    fireEvent.click(b);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('Meshtastic Security tab keeps its sections (P7b)', () => {
  const mtNode = (over: Record<string, unknown>) => ({
    nodeKey: 'mt:4660', protocol: 'meshtastic', nodeNum: 4660, shortName: 'Spam', longName: 'Spammer', lastHeard: nowSec - 30,
    keyIsLowEntropy: false, duplicateKeyDetected: false, hwModel: 9, isExcessivePackets: false, packetRatePerHour: null,
    isTimeOffsetIssue: false, timeOffsetSeconds: null, ...over,
  });
  const mtIssues = (nodes: unknown[]) => ({
    total: nodes.length, lowEntropyCount: (nodes as any[]).filter(n => n.keyIsLowEntropy).length, duplicateKeyCount: 0,
    excessivePacketsCount: (nodes as any[]).filter(n => n.isExcessivePackets).length,
    timeOffsetCount: (nodes as any[]).filter(n => n.isTimeOffsetIssue).length, nodes,
    topBroadcasters: [{ nodeNum: 4660, shortName: 'Spam', longName: 'Spammer', packetCount: 50 }],
  });

  it('renders the same sections and DOM classes', async () => {
    route(mtIssues([mtNode({ isExcessivePackets: true, packetRatePerHour: 50, isTimeOffsetIssue: true, timeOffsetSeconds: 4000 })]));
    const { container } = render(<SecurityTab sourceType="meshtastic_tcp" />);
    expect(await screen.findByText('security.scanner_status')).toBeTruthy();
    for (const sel of ['.security-header .header-actions .export-dropdown', '.scanner-status .status-card', '.digest-section',
      '.security-stats .stat-card.total', '.top-broadcasters-section table.top-broadcasters-table', '.issue-card .issue-header .node-info',
      '.badge.excessive-packets', '.badge.time-offset']) {
      expect(container.querySelector(sel), sel).not.toBeNull();
    }
    expect(screen.getByText('!00001234')).toBeTruthy();
  });

  it('low-entropy and duplicate texts are unchanged; new rows get the Send notification button', async () => {
    route(mtIssues([
      mtNode({ keyIsLowEntropy: true }),
      mtNode({ nodeKey: 'mt:2', nodeNum: 2, isExcessivePackets: true, packetRatePerHour: 50 }),
    ]));
    const open = vi.fn();
    render(<SecurityTab sourceType="meshtastic_tcp" onOpenDmWithDraft={open} />);
    await screen.findByText(/security\.excessive_packets_count/);
    const btns = Array.from(document.querySelectorAll('.send-notification-btn'));
    expect(btns).toHaveLength(2);
    fireEvent.click(btns[0]);
    expect(open).toHaveBeenCalledWith('mt:4660', 'MeshMonitor Security Notification: Your node has a low entropy key. Read more: https://bit.ly/4oL5m0P');
    fireEvent.click(btns[1]);
    expect(open).toHaveBeenLastCalledWith('mt:2', 'MeshMonitor: your node sends 50 packets/hr. Please check it.');
  });
});

describe('Security tab — source not connected (#4173 N5)', () => {
  it('shows the not-connected state, not the raw error, on SOURCE_NOT_CONNECTED', async () => {
    route(mcIssues([]));
    const base = h.get.getMockImplementation()!;
    h.get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/security/meshcore/findings')) {
        throw Object.assign(new h.ApiError('Source src-1 is not connected', 409), { code: 'SOURCE_NOT_CONNECTED' });
      }
      return base(url);
    });
    render(<SecurityTab sourceType="meshcore" sourceId="src-1" deviceType={1} />);
    expect(await screen.findByTestId('source-not-connected')).toBeTruthy();
    expect(screen.queryByText(/is not connected/)).toBeNull();
    expect(screen.queryByText(/security\.error_loading/)).toBeNull();
  });
});
