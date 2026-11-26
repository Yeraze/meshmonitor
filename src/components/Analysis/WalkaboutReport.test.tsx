/**
 * @vitest-environment jsdom
 *
 * Walkabout report (#5891 P1): notices, consent flow, posting cadence, retry,
 * session end, resume, delete, source picker. #6573: export, import, imported sessions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WalkaboutSessionDto } from '../../types/walkabout';

const hasPermission = vi.fn();
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission }),
}));

const apiGet = vi.fn();
vi.mock('../../services/api', () => ({
  default: { get: (...a: unknown[]) => apiGet(...a), setBaseUrl: vi.fn() },
}));

const fetchWalkaboutSessions = vi.fn();
const fetchLiveWalkabout = vi.fn();
const startWalkabout = vi.fn();
const postWalkaboutSamples = vi.fn();
const stopWalkabout = vi.fn();
const deleteWalkabout = vi.fn();
const fetchWalkaboutExport = vi.fn();
vi.mock('../../services/walkaboutApi', () => ({
  fetchWalkaboutExport: (...a: unknown[]) => fetchWalkaboutExport(...a),
  fetchWalkaboutSessions: (...a: unknown[]) => fetchWalkaboutSessions(...a),
  fetchLiveWalkabout: (...a: unknown[]) => fetchLiveWalkabout(...a),
  startWalkabout: (...a: unknown[]) => startWalkabout(...a),
  postWalkaboutSamples: (...a: unknown[]) => postWalkaboutSamples(...a),
  stopWalkabout: (...a: unknown[]) => stopWalkabout(...a),
  deleteWalkabout: (...a: unknown[]) => deleteWalkabout(...a),
}));

const deleteCoverageImport = vi.fn();
vi.mock('../../services/coverageImportApi', () => ({
  deleteCoverageImport: (...a: unknown[]) => deleteCoverageImport(...a),
  fetchCoverageImports: vi.fn(),
  uploadCoverageImport: vi.fn(),
  CoverageImportUploadError: class extends Error {},
}));
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => vi.fn() }));

const downloadTextFile = vi.fn();
vi.mock('../../utils/nodeExport', async (orig) => ({
  ...(await orig<typeof import('../../utils/nodeExport')>()),
  downloadTextFile: (...a: unknown[]) => downloadTextFile(...a),
}));

const mapPanelProps = vi.fn();
vi.mock('./walkaboutHexMapLazy', () => ({
  WalkaboutHexMapLazy: (props: unknown) => {
    mapPanelProps(props);
    return <div data-testid="hex-map-stub" />;
  },
}));

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import WalkaboutReport from './WalkaboutReport';

const NOW = 1_700_000_000_000;

const session = (over: Partial<WalkaboutSessionDto> = {}): WalkaboutSessionDto => ({
  id: 's1',
  sourceId: 'a',
  name: null,
  startedAt: NOW,
  endedAt: null,
  endsAt: NOW + 2 * 3_600_000,
  isLive: true,
  endReason: null,
  startedByMe: true,
  sampleCount: 0,
  receptionCount: 0,
  nodeCount: 0,
  lastSampleAt: null,
  ...over,
});

const SOURCES = [
  { id: 'a', name: 'Alpha', type: 'meshtastic_tcp', enabled: true },
  { id: 'b', name: 'Beta MC', type: 'meshcore', enabled: true },
  { id: 'm', name: 'MQTT Feed', type: 'mqtt_broker', enabled: true },
  { id: 'r', name: 'ReadOnly', type: 'meshtastic_tcp', enabled: true },
];

let posCb: (p: GeolocationPosition) => void;
const watchPosition = vi.fn((ok: (p: GeolocationPosition) => void) => { posCb = ok; return 1; });
const clearWatch = vi.fn();

const fixAt = (accuracy: number, timestamp: number) => ({
  coords: { latitude: 10, longitude: 20, accuracy },
  timestamp,
}) as unknown as GeolocationPosition;

// Sources load first, then the per-source queries: flush a few rounds.
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(5); });
};
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function renderReport() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(
    <QueryClientProvider client={qc}>
      <WalkaboutReport />
    </QueryClientProvider>,
  );
}

async function startWalking() {
  renderReport();
  await flush();
  fireEvent.click(screen.getByTestId('walkabout-start'));
  fireEvent.click(screen.getByTestId('walkabout-confirm-start'));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.clearAllMocks();
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'geolocation', {
    value: { watchPosition, clearWatch, getCurrentPosition: vi.fn() },
    configurable: true,
  });
  Object.defineProperty(navigator, 'wakeLock', { value: undefined, configurable: true });
  // Write on a, b, m; read-only on r.
  hasPermission.mockImplementation((_r: string, action: string, o?: { sourceId?: string }) =>
    action === 'read' ? true : ['a', 'b', 'm'].includes(o?.sourceId ?? ''));
  apiGet.mockResolvedValue(SOURCES);
  fetchWalkaboutSessions.mockResolvedValue([]);
  fetchLiveWalkabout.mockResolvedValue({ session: null, skipped: null });
  startWalkabout.mockResolvedValue(session());
  postWalkaboutSamples.mockResolvedValue({
    accepted: 1,
    dropped: { accuracy: 0, spacing: 0, stale: 0, invalid: 0 },
    session: session({ sampleCount: 3, receptionCount: 17, nodeCount: 5 }),
    skipped: { noFix: 0, relayAmbiguous: 0, relayUnknown: 0, noSender: 0 },
  });
  stopWalkabout.mockResolvedValue(session({ isLive: false, endedAt: NOW + 1000 }));
  deleteWalkabout.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

describe('WalkaboutReport', () => {
  it('shows the insecure notice and disables Start', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    renderReport();
    await flush();
    expect(screen.getByTestId('walkabout-notice').textContent).toMatch(/HTTPS/);
    expect((screen.getByTestId('walkabout-start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows an unavailable notice without geolocation', async () => {
    Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true });
    renderReport();
    await flush();
    expect(screen.getByTestId('walkabout-notice')).toBeTruthy();
    expect((screen.getByTestId('walkabout-start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('picker lists only Meshtastic/MeshCore sources with read', async () => {
    renderReport();
    await flush();
    const names = within(screen.getByTestId('walkabout-source')).getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['Alpha', 'Beta MC', 'ReadOnly']);
  });

  it('write on A, read-only on B: both listed, Start only where writable', async () => {
    renderReport();
    await flush();
    // Default is the first writable source.
    expect((screen.getByTestId('walkabout-source') as HTMLSelectElement).value).toBe('a');
    expect(screen.getByTestId('walkabout-start')).toBeTruthy();
    fireEvent.change(screen.getByTestId('walkabout-source'), { target: { value: 'r' } });
    await flush();
    expect(screen.queryByTestId('walkabout-start')).toBeNull();
    expect(screen.queryByTestId('walkabout-resume')).toBeNull();
  });

  it('defaults to the first readable source when none is writable', async () => {
    hasPermission.mockImplementation((_r: string, action: string) => action === 'read');
    renderReport();
    await flush();
    expect((screen.getByTestId('walkabout-source') as HTMLSelectElement).value).toBe('a');
  });

  it('the map panel is not mounted while walking, and mounts after stop', async () => {
    renderReport();
    await flush();
    expect(screen.getByTestId('walkabout-map-panel')).toBeTruthy();
    fireEvent.click(screen.getByTestId('walkabout-start'));
    fireEvent.click(screen.getByTestId('walkabout-confirm-start'));
    await flush();
    expect(screen.queryByTestId('walkabout-map-panel')).toBeNull();
    expect(screen.queryByTestId('hex-map-stub')).toBeNull();
    expect(screen.getByTestId('walkabout-map-while-walking')).toBeTruthy();
    fireEvent.click(screen.getByTestId('walkabout-stop'));
    await flush();
    expect(screen.getByTestId('walkabout-map-panel')).toBeTruthy();
  });

  it('the Map button on a finished session opens the panel on that session', async () => {
    fetchWalkaboutSessions.mockResolvedValue([session({ id: 's9', isLive: false, endedAt: NOW + 60_000, name: 'Loop' })]);
    renderReport();
    await flush();
    fireEvent.click(screen.getByTestId('walkabout-map-button'));
    await flush();
    expect(mapPanelProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceId: 'a', query: { kind: 'session', sessionId: 's9' } }),
    );
  });

  it('read-only user sees the list but no Start', async () => {
    hasPermission.mockImplementation((_r: string, action: string) => action === 'read');
    fetchWalkaboutSessions.mockResolvedValue([session({ isLive: false, endedAt: NOW + 60_000, name: 'Loop' })]);
    renderReport();
    await flush();
    expect(screen.queryByTestId('walkabout-start')).toBeNull();
    expect(within(screen.getByTestId('walkabout-sessions')).getByText('Loop')).toBeTruthy();
    expect(screen.queryByTestId('walkabout-delete')).toBeNull();
  });

  it('Start dialog says to carry the radio, track visibility, and screen lock', async () => {
    renderReport();
    await flush();
    fireEvent.click(screen.getByTestId('walkabout-start'));
    const modal = screen.getByTestId('walkabout-start-modal');
    expect(modal.textContent).toMatch(/Carry the radio/);
    expect(modal.textContent).toMatch(/left at home/);
    expect(modal.textContent).toMatch(/anyone who can read this source/);
    expect(screen.getByTestId('walkabout-modal-screen-lock').textContent).toMatch(/screen on/);
    expect(watchPosition).not.toHaveBeenCalled();
  });

  it('confirming starts the session and the watch, with the live panel', async () => {
    await startWalking();
    expect(startWalkabout).toHaveBeenCalledWith('a', undefined);
    expect(watchPosition).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('walkabout-live')).toBeTruthy();
    expect(screen.getByTestId('walkabout-live-screen-lock').textContent).toMatch(/screen on/);
    expect(screen.getByTestId('walkabout-remaining').textContent).toMatch(/^(2:00:00|1:59:5\d)$/);
  });

  it('shows a 409 already-live error in the dialog and does not watch', async () => {
    startWalkabout.mockRejectedValue(Object.assign(new Error('live'), { code: 'WALKABOUT_ALREADY_LIVE' }));
    renderReport();
    await flush();
    fireEvent.click(screen.getByTestId('walkabout-start'));
    fireEvent.click(screen.getByTestId('walkabout-confirm-start'));
    await flush();
    expect(screen.getByRole('alert').textContent).toMatch(/already running/);
    expect(watchPosition).not.toHaveBeenCalled();
  });

  it('warns above 30 m and says waiting above 100 m', async () => {
    await startWalking();
    await act(async () => { posCb(fixAt(45, NOW)); });
    expect(screen.getByTestId('walkabout-accuracy-warn')).toBeTruthy();
    await act(async () => { posCb(fixAt(150, NOW + 6000)); });
    expect(screen.queryByTestId('walkabout-accuracy-warn')).toBeNull();
    expect(screen.getByTestId('walkabout-accuracy-wait')).toBeTruthy();
  });

  it('posts every 10 s, only with samples, and renders counts from the response', async () => {
    await startWalking();
    await advance(10_000);
    expect(postWalkaboutSamples).not.toHaveBeenCalled();
    await act(async () => { posCb(fixAt(10, NOW + 10_000)); });
    await advance(10_000);
    expect(postWalkaboutSamples).toHaveBeenCalledTimes(1);
    const [src, id, batch] = postWalkaboutSamples.mock.calls[0];
    expect([src, id]).toEqual(['a', 's1']);
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ latitude: 10, longitude: 20, accuracyM: 10, deviceFixAt: NOW + 10_000 });
    expect(screen.getByTestId('walkabout-samples').textContent).toBe('3');
    expect(screen.getByTestId('walkabout-receptions').textContent).toBe('17');
    expect(screen.getByTestId('walkabout-nodes').textContent).toBe('5');
  });

  it('the live row in the session list shows the latest counts from the post', async () => {
    fetchWalkaboutSessions.mockResolvedValue([session()]);
    await startWalking();
    await act(async () => { posCb(fixAt(10, NOW + 1000)); });
    await advance(10_000);
    const row = screen.getByTestId('walkabout-session');
    expect(row.textContent).toMatch(/3 samples, 17 receptions, 5 nodes/);
  });

  it('on a failed post keeps the batch and retries on the next 10 s tick', async () => {
    postWalkaboutSamples.mockRejectedValueOnce(Object.assign(new Error('Too many'), { status: 429 }));
    await startWalking();
    await act(async () => { posCb(fixAt(10, NOW + 1000)); });
    await advance(10_000);
    expect(postWalkaboutSamples).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('walkabout-send-trouble')).toBeTruthy();
    await advance(10_000);
    expect(postWalkaboutSamples).toHaveBeenCalledTimes(2);
    expect(postWalkaboutSamples.mock.calls[1][2][0].deviceFixAt).toBe(NOW + 1000);
  });

  it.each([
    ['WALKABOUT_NOT_FOUND', {}],
    ['WALKABOUT_NOT_OWNER', {}],
    ['FORBIDDEN', {}],
    [undefined, { status: 404 }],
    [undefined, { status: 403 }],
  ])('terminal error %s %j ends the walk and stops GPS', async (code, extra) => {
    postWalkaboutSamples.mockRejectedValueOnce(Object.assign(new Error('x'), { code }, extra));
    await startWalking();
    await act(async () => { posCb(fixAt(10, NOW + 1000)); });
    await advance(10_000);
    expect(clearWatch).toHaveBeenCalled();
    expect(screen.queryByTestId('walkabout-live')).toBeNull();
    expect(screen.getByTestId('walkabout-ended').textContent).toMatch(/gone|no longer/);
    await advance(30_000);
    expect(postWalkaboutSamples).toHaveBeenCalledTimes(1);
  });

  it('posts and stops against the session sourceId, not the picker', async () => {
    startWalkabout.mockResolvedValue(session({ sourceId: 'zzz' }));
    postWalkaboutSamples.mockResolvedValue({
      accepted: 1,
      dropped: { accuracy: 0, spacing: 0, stale: 0, invalid: 0 },
      session: session({ sourceId: 'zzz', sampleCount: 1 }),
      skipped: { noFix: 0, relayAmbiguous: 0, relayUnknown: 0, noSender: 0 },
    });
    await startWalking();
    await act(async () => { posCb(fixAt(10, NOW + 1000)); });
    await advance(10_000);
    expect(postWalkaboutSamples.mock.calls[0][0]).toBe('zzz');
    fireEvent.click(screen.getByTestId('walkabout-stop'));
    await flush();
    expect(stopWalkabout).toHaveBeenCalledWith('zzz', 's1');
  });

  it('WALKABOUT_NOT_LIVE stops the watch and shows the 2 h message', async () => {
    postWalkaboutSamples.mockRejectedValueOnce(
      Object.assign(new Error('over'), { code: 'WALKABOUT_NOT_LIVE', body: { endReason: 'cap' } }),
    );
    await startWalking();
    await act(async () => { posCb(fixAt(10, NOW + 1000)); });
    await advance(10_000);
    expect(clearWatch).toHaveBeenCalled();
    expect(screen.queryByTestId('walkabout-live')).toBeNull();
    expect(screen.getByTestId('walkabout-ended').textContent).toMatch(/2 h limit/);
  });

  it('Stop flushes the queue, stops the session and the watch', async () => {
    await startWalking();
    await act(async () => { posCb(fixAt(10, NOW + 1000)); });
    fireEvent.click(screen.getByTestId('walkabout-stop'));
    await flush();
    expect(postWalkaboutSamples).toHaveBeenCalledTimes(1);
    expect(stopWalkabout).toHaveBeenCalledWith('a', 's1');
    expect(clearWatch).toHaveBeenCalled();
    expect(screen.getByTestId('walkabout-ended').textContent).toMatch(/stopped/);
  });

  it('a failed stop shows its own error next to Stop, not in the Start dialog', async () => {
    stopWalkabout.mockRejectedValueOnce(Object.assign(new Error('Server down'), { status: 500 }));
    await startWalking();
    fireEvent.click(screen.getByTestId('walkabout-stop'));
    await flush();
    expect(screen.getByTestId('walkabout-stop-error').textContent).toBe('Server down');
    expect(screen.getByTestId('walkabout-live')).toBeTruthy();
    expect(screen.queryByTestId('walkabout-start-modal')).toBeNull();
    stopWalkabout.mockResolvedValueOnce(session({ isLive: false }));
    fireEvent.click(screen.getByTestId('walkabout-stop'));
    await flush();
    expect(screen.queryByTestId('walkabout-live')).toBeNull();
  });

  it('offers Resume only for my own live session', async () => {
    fetchLiveWalkabout.mockResolvedValue({ session: session(), skipped: null });
    renderReport();
    await flush();
    expect(screen.getByTestId('walkabout-resume')).toBeTruthy();
    expect(screen.queryByTestId('walkabout-start')).toBeNull();
    fireEvent.click(screen.getByTestId('walkabout-resume'));
    expect(watchPosition).toHaveBeenCalledTimes(1);
    expect(startWalkabout).not.toHaveBeenCalled();
  });

  it('another users live session blocks Start', async () => {
    fetchLiveWalkabout.mockResolvedValue({ session: session({ startedByMe: false }), skipped: null });
    renderReport();
    await flush();
    expect(screen.getByTestId('walkabout-other-user')).toBeTruthy();
    expect(screen.queryByTestId('walkabout-resume')).toBeNull();
    expect((screen.getByTestId('walkabout-start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('delete asks for confirmation first', async () => {
    fetchWalkaboutSessions.mockResolvedValue([session({ id: 'old', isLive: false, endedAt: NOW + 60_000, sampleCount: 4 })]);
    renderReport();
    await flush();
    fireEvent.click(screen.getByTestId('walkabout-delete'));
    expect(deleteWalkabout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('walkabout-confirm-delete'));
    await flush();
    expect(deleteWalkabout).toHaveBeenCalledWith('a', 'old');
  });

  describe('export and import (#6573)', () => {
    const exportDoc = {
      meshmonitor: { format: 'meshmonitor-walkabout', version: 1, exportedAt: NOW, hiddenReceptionCount: 3, truncated: false },
      sessions: [{
        name: null, startedAt: NOW, endedAt: NOW + 60_000, endReason: 'user',
        samples: [{ id: 1, latitude: 10, longitude: 20, accuracyM: 5, deviceFixAt: NOW, fixAt: NOW, receivedAt: NOW }],
        receptions: [],
      }],
    };

    it('exports a finished session as JSON, then CSV from the same fetch, and shows the hidden count', async () => {
      fetchWalkaboutSessions.mockResolvedValue([session({ id: 'old', isLive: false, endedAt: NOW + 60_000 })]);
      fetchWalkaboutExport.mockResolvedValue(exportDoc);
      renderReport();
      await flush();
      fireEvent.click(screen.getByTestId('walkabout-export-button'));
      fireEvent.click(screen.getByTestId('walkabout-export-json'));
      await flush();
      expect(fetchWalkaboutExport).toHaveBeenCalledWith('a', 'old');
      const [name, body, mime] = downloadTextFile.mock.calls[0];
      expect(name).toMatch(/^walkabout_.*\.json$/);
      expect(JSON.parse(body)).toEqual(exportDoc);
      expect(mime).toBe('application/json');
      expect(screen.getByTestId('walkabout-export-hidden').textContent).toMatch(/3/);
      fireEvent.click(screen.getByTestId('walkabout-export-csv'));
      await flush();
      expect(fetchWalkaboutExport).toHaveBeenCalledTimes(1);
      expect(downloadTextFile.mock.calls[1][0]).toMatch(/\.csv$/);
    });

    it('no Export button on a live session', async () => {
      fetchWalkaboutSessions.mockResolvedValue([session({ id: 'live', isLive: true })]);
      renderReport();
      await flush();
      expect(screen.queryByTestId('walkabout-export-button')).toBeNull();
    });

    it('an imported session is tagged, and Delete removes its import', async () => {
      fetchWalkaboutSessions.mockResolvedValue([
        session({ id: 'imp', isLive: false, endedAt: NOW + 60_000, importId: 'batch-1' }),
      ]);
      deleteCoverageImport.mockResolvedValue(undefined);
      renderReport();
      await flush();
      expect(screen.getByTestId('walkabout-imported-tag')).toBeTruthy();
      fireEvent.click(screen.getByTestId('walkabout-delete'));
      expect(screen.getByTestId('walkabout-delete-modal').textContent).toMatch(/whole import/);
      fireEvent.click(screen.getByTestId('walkabout-confirm-delete'));
      await flush();
      expect(deleteCoverageImport).toHaveBeenCalledWith('a', 'batch-1');
      expect(deleteWalkabout).not.toHaveBeenCalled();
    });

    it('Import opens the walkabout import dialog for writable walkabout sources only', async () => {
      renderReport();
      await flush();
      fireEvent.click(screen.getByTestId('walkabout-import'));
      const dialog = screen.getByTestId('coverage-import-dialog');
      expect(dialog.textContent).toMatch(/walkabout session/);
      const options = within(dialog).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
      expect(options).toEqual(['a', 'b']);
      expect((within(dialog).getByTestId('coverage-import-file') as HTMLInputElement).accept).toBe('.json');
    });

    it('a read-only user gets Export but no Import', async () => {
      hasPermission.mockImplementation((_r: string, action: string) => action === 'read');
      fetchWalkaboutSessions.mockResolvedValue([session({ id: 'old', isLive: false, endedAt: NOW + 60_000 })]);
      renderReport();
      await flush();
      expect(screen.getByTestId('walkabout-export-button')).toBeTruthy();
      expect(screen.queryByTestId('walkabout-import')).toBeNull();
    });
  });
});
