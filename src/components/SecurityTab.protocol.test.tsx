/**
 * @vitest-environment jsdom
 *
 * SecurityTab protocol adapters (#6254): Meshtastic keeps today's sections,
 * MeshCore swaps in the new ones; the dead-node list keys on nodeKey.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

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
  ApiError: class ApiError extends Error {
    status: number;
    constructor(m: string, status: number) { super(m); this.status = status; }
  },
}));
vi.mock('../services/api', () => ({ default: { get: h.get, post: h.post, download: vi.fn() }, ApiError: h.ApiError }));

import { SecurityTab } from './SecurityTab';

const nowSec = Math.floor(Date.now() / 1000);
const mtDead = { nodeKey: 'mt:5', protocol: 'meshtastic', nodeNum: 5, nodeId: '!00000005', longName: 'Old', shortName: 'OLD', hwModel: null, lastHeard: nowSec - 40 * 86400, inDeviceDb: false };
const mcDead = { nodeKey: `mc:${'ab'.repeat(32)}`, protocol: 'meshcore', nodeNum: 1, nodeId: 'ab'.repeat(32), longName: 'Rep', shortName: 'Rep', hwModel: null, lastHeard: nowSec - 40 * 86400, inDeviceDb: true };
const neverHeard = { ...mcDead, nodeKey: `mc:${'cd'.repeat(32)}`, nodeId: 'cd'.repeat(32), longName: 'Ghost', lastHeard: null };

const fnode = (pk: string, name: string) => ({ publicKey: pk, nodeKey: `mc:${pk}`, name, advType: 2, lastHeard: Date.now(), firstHeard: 1, advertSignatureVerified: false });
const findings = (ownKey: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    pathHashCollisions: { width: 1, countsByWidth: { 1: 1, 2: 0, 3: 0 }, groups: [{ hash: 'ab', nodes: [fnode('ab01', 'R1'), fnode('ab02', 'R2')] }] },
    signatureFailures: [fnode('ee01', 'Forger')],
    nameReuse: [{ name: 'Alice', original: fnode('aa01', 'Alice'), suspects: [fnode('aa02', 'alice')] }],
    ownKey: { currentKey: 'f'.repeat(64), previousKey: null, detectedAt: null, pkiKeyMismatch: false, ...ownKey },
  },
});

function route(opts: { dead?: unknown[]; findings?: unknown; deadStatus?: number; findingsStatus?: number } = {}) {
  h.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/security/dead-nodes')) {
      if (opts.deadStatus) throw new h.ApiError('forbidden', opts.deadStatus);
      return { nodes: opts.dead ?? [], count: (opts.dead ?? []).length, thresholdDays: 14 };
    }
    if (url.startsWith('/api/security/meshcore/findings')) {
      if (opts.findingsStatus) throw new h.ApiError('forbidden', opts.findingsStatus);
      return opts.findings ?? findings();
    }
    if (url.startsWith('/api/security/issues')) {
      return { total: 1, lowEntropyCount: 1, duplicateKeyCount: 0, excessivePacketsCount: 0, timeOffsetCount: 0, nodes: [], topBroadcasters: [] };
    }
    if (url.startsWith('/api/security/scanner/status')) return { running: true, scanningNow: false, intervalHours: 6, lastScanTime: null };
    if (url.startsWith('/api/security/key-mismatches')) return { events: [] };
    if (url === '/api/settings') return {};
    return {};
  });
}

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset().mockResolvedValue({});
  perms = { 'security:read': true, 'security:write': true, 'nodes:write': true, 'settings:write': true };
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('SecurityTab protocol adapters', () => {
  it('Meshtastic renders the scanner, digest and dead-node sections, not the MeshCore ones', async () => {
    route({ dead: [mtDead] });
    render(<SecurityTab sourceType="meshtastic_tcp" />);
    expect(await screen.findByText('security.scanner_status')).toBeTruthy();
    expect(screen.getByText('Security Digest')).toBeTruthy();
    expect(screen.getByTestId('security-dead-nodes')).toBeTruthy();
    expect(screen.queryByTestId('security-path-hash-collisions')).toBeNull();
    expect(h.get.mock.calls.some(([u]) => String(u).includes('/meshcore/findings'))).toBe(false);
  });

  it('MeshCore hides low-entropy/duplicate and shows the P7a sections plus scanner and digest (#6281)', async () => {
    route({ dead: [mcDead] });
    render(<SecurityTab sourceType="meshcore" sourceId="src-1" />);
    expect(await screen.findByTestId('security-path-hash-collisions')).toBeTruthy();
    expect(screen.getByTestId('security-advert-signatures')).toBeTruthy();
    expect(screen.getByTestId('security-name-reuse')).toBeTruthy();
    expect(screen.getByTestId('security-dead-nodes')).toBeTruthy();
    expect(screen.getByTestId('security-dead-nodes-reappear')).toBeTruthy();
    expect(screen.getByText('security.scanner_status')).toBeTruthy();
    expect(screen.getByText('Security Digest')).toBeTruthy();
    expect(screen.queryByText(/security\.low_entropy_count/)).toBeNull();
    expect(h.get.mock.calls.some(([u]) => String(u).includes('/api/security/issues'))).toBe(true);
  });

  it('bulk delete sends nodeKeys and sourceId; never-heard rows are not in Select All', async () => {
    route({ dead: [mcDead, neverHeard] });
    render(<SecurityTab sourceType="meshcore" sourceId="src-1" />);
    fireEvent.click(await screen.findByText('Select All'));
    fireEvent.click(screen.getByText('Delete 1 node(s)'));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/api/security/dead-nodes/bulk-delete', { sourceId: 'src-1', nodeKeys: [mcDead.nodeKey] }));
  });

  it('hides the delete control without nodes:write', async () => {
    perms['nodes:write'] = false;
    route({ dead: [mcDead] });
    render(<SecurityTab sourceType="meshcore" sourceId="src-1" />);
    fireEvent.click(await screen.findByText('Select All'));
    expect(screen.queryByText('Delete 1 node(s)')).toBeNull();
  });

  it('saves the threshold per source', async () => {
    route({ dead: [mcDead] });
    render(<SecurityTab sourceType="meshcore" sourceId="src-1" />);
    const input = await screen.findByLabelText('Dead after (days)');
    // Wait until the input is editable and Save is enabled (permissions and the
    // threshold load async; clicking a disabled Save was flaky under CI load).
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(input, { target: { value: '30' } });
    const save = within(screen.getByTestId('security-dead-nodes')).getByText('Save').closest('button') as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/api/settings?sourceId=src-1', { securityDeadNodeDays: '30' }));
  });

  it('clears the previous source\'s dead nodes on a source switch and drops its late response', async () => {
    route({ dead: [mcDead] });
    const { rerender } = render(<SecurityTab sourceType="meshcore" sourceId="src-1" />);
    expect(await screen.findByText('Rep')).toBeTruthy();
    // src-2's dead-node request never resolves: the old list must not linger.
    let releaseOld: (v: unknown) => void = () => {};
    h.get.mockImplementation(async (url: string) => {
      if (url.includes('sourceId=src-2') && url.startsWith('/api/security/dead-nodes')) return new Promise(() => {});
      if (url.startsWith('/api/security/meshcore/findings')) return findings();
      if (url.includes('sourceId=src-1')) return new Promise((r) => { releaseOld = r; });
      return {};
    });
    rerender(<SecurityTab sourceType="meshcore" sourceId="src-2" />);
    await waitFor(() => expect(screen.queryByText('Rep')).toBeNull());
    releaseOld({ nodes: [mcDead], count: 1, thresholdDays: 14 });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Rep')).toBeNull();
  });

  const ownKeyChange = { previousKey: 'a'.repeat(64), detectedAt: Date.now() };

  it('shows acknowledge on the own-key card with security:write and posts the source', async () => {
    route({ dead: [], findings: findings(ownKeyChange) });
    render(<SecurityTab sourceType="meshcore" sourceId="src-1" />);
    fireEvent.click(await screen.findByText('Acknowledge'));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/api/security/own-key/acknowledge', { sourceId: 'src-1' }));
  });

  it('hides acknowledge without security:write but still shows the card', async () => {
    perms['security:write'] = false;
    route({ dead: [], findings: findings(ownKeyChange) });
    render(<SecurityTab sourceType="meshcore" sourceId="src-1" />);
    expect(await screen.findByTestId('security-own-key-change')).toBeTruthy();
    expect(screen.queryByText('Acknowledge')).toBeNull();
  });

  it('a 403 on dead-nodes and findings shows a note per section and stops polling them', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    route({ deadStatus: 403, findingsStatus: 403 });
    render(<SecurityTab sourceType="meshcore" sourceId="src-1" />);
    expect(await screen.findByTestId('security-dead-nodes-forbidden')).toBeTruthy();
    expect(screen.getByTestId('security-findings-forbidden')).toBeTruthy();
    // The two forbidden sections stop polling; the rest of the page keeps its 30 s refresh.
    const forbiddenCalls = () => h.get.mock.calls.filter(([u]) => /\/dead-nodes|\/meshcore\/findings/.test(String(u))).length;
    const calls = forbiddenCalls();
    await vi.advanceTimersByTimeAsync(95_000);
    expect(forbiddenCalls()).toBe(calls);
    vi.useRealTimers();
  });

  it('on Meshtastic a dead-nodes 403 leaves the rest of the page working', async () => {
    route({ deadStatus: 403 });
    render(<SecurityTab sourceType="meshtastic_tcp" />);
    expect(await screen.findByTestId('security-dead-nodes-forbidden')).toBeTruthy();
    expect(screen.getByText('security.scanner_status')).toBeTruthy();
  });
});
