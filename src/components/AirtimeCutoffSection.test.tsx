/**
 * @vitest-environment jsdom
 *
 * Airtime cutoff section (issue #6007): Auto/Manual mode toggle, the 3-5
 * sample count, the manual picker (eligible non-MQTT infrastructure only, with
 * role/hops/ChUtil), the 3-5 pick limit, and the status line that says when
 * the local ChUtil filled the gap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});

const fetchMock = vi.fn();
const showToast = vi.fn();
let saveBar: { onSave: () => Promise<void>; hasChanges: boolean } | null = null;

vi.mock('../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => fetchMock }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../hooks/useSourceQuery', () => ({ useSourceQuery: () => '?sourceId=src-a' }));
vi.mock('../hooks/useSaveBar', () => ({
  useSaveBar: (opts: { onSave: () => Promise<void>; hasChanges: boolean }) => {
    saveBar = opts;
  },
}));

import AirtimeCutoffSection from './AirtimeCutoffSection';

const NOW = Date.now();
const jsonRes = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

let settings: Record<string, string>;
let status: Record<string, unknown>;
let candidates: unknown[];

beforeEach(() => {
  vi.clearAllMocks();
  saveBar = null;
  settings = { automationAirtimeCutoffThreshold: '30', automationAirtimeCutoffSource: 'neighbors' };
  status = { threshold: 30, source: 'neighbors', neighborMaxHops: 0, channelUtilization: 20, sampleCount: 3, contributors: [], gated: false };
  candidates = [
    { nodeNum: 0xa1, nodeId: '!000000a1', longName: 'Hill Router', shortName: 'HILL', role: 2, hopsAway: 0, rssi: -60, channelUtilization: 12.5, channelUtilizationAt: NOW - 5 * 60000 },
    { nodeNum: 0xa2, nodeId: '!000000a2', longName: 'Tower Late', shortName: 'TWR', role: 11, hopsAway: 1, rssi: -80, channelUtilization: 22, channelUtilizationAt: NOW - 2 * 3600000 },
    { nodeNum: 0xa3, nodeId: '!000000a3', longName: 'Base', shortName: 'BASE', role: 12, hopsAway: 2, rssi: null, channelUtilization: null, channelUtilizationAt: null },
    { nodeNum: 0xa4, nodeId: '!000000a4', longName: 'Four', shortName: 'FOUR', role: 2, hopsAway: 0, rssi: -70, channelUtilization: 5, channelUtilizationAt: NOW },
    { nodeNum: 0xa5, nodeId: '!000000a5', longName: 'Five', shortName: 'FIVE', role: 2, hopsAway: 0, rssi: -71, channelUtilization: 5, channelUtilizationAt: NOW },
    { nodeNum: 0xa6, nodeId: '!000000a6', longName: 'Six', shortName: 'SIX', role: 2, hopsAway: 0, rssi: -72, channelUtilization: 5, channelUtilizationAt: NOW },
  ];
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return jsonRes({ success: true });
    if (url.includes('/api/automation/airtime-candidates')) return jsonRes({ success: true, data: { candidates } });
    if (url.includes('/api/automation/airtime-status')) return jsonRes(status);
    return jsonRes(settings);
  });
});

const renderSection = async () => {
  render(<AirtimeCutoffSection baseUrl="" />);
  await waitFor(() => expect(screen.getByLabelText(/Choose infrastructure nodes/)).toBeTruthy());
};

describe('AirtimeCutoffSection (#6007)', () => {
  it('defaults to Auto with a 3-5 sample count input and no picker', async () => {
    await renderSection();
    const mode = screen.getByLabelText(/Choose infrastructure nodes/) as HTMLSelectElement;
    expect(mode.value).toBe('auto');
    const count = screen.getByLabelText(/Number of infrastructure nodes to average/) as HTMLInputElement;
    expect(count.value).toBe('3');
    expect(count.getAttribute('min')).toBe('3');
    expect(count.getAttribute('max')).toBe('5');
    fireEvent.change(count, { target: { value: '9' } });
    expect(count.getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByTestId('airtime-picker')).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('airtime-candidates'))).toBe(false);
  });

  it('Manual lists eligible nodes with role, hops and ChUtil, and caps picks at 5', async () => {
    await renderSection();
    fireEvent.change(screen.getByLabelText(/Choose infrastructure nodes/), { target: { value: 'manual' } });
    await waitFor(() => expect(screen.getByTestId('airtime-picker')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/automation/airtime-candidates?sourceId=src-a');
    expect(screen.queryByLabelText(/Number of infrastructure nodes to average/)).toBeNull();
    expect(screen.queryByLabelText(/Maximum hops/)).toBeNull();

    const picker = screen.getByTestId('airtime-picker');
    expect(picker.textContent).toContain('Hill Router');
    expect(picker.textContent).toContain('Router · 0 hop(s) · 12.5% (5 min ago)');
    expect(picker.textContent).toContain('Router Late · 1 hop(s) · 22% (2 h ago)');
    expect(picker.textContent).toContain('Client Base · 2 hop(s) · — (no reading)');

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    boxes.slice(0, 5).forEach((b) => fireEvent.click(b));
    expect(boxes.slice(0, 5).every((b) => b.checked)).toBe(true);
    expect(boxes[5].disabled).toBe(true);
    expect(screen.getByTestId('airtime-picker-count').textContent).toContain('5 selected');
  });

  it('blocks saving Manual with fewer than 3 picks, then saves 3 picks', async () => {
    await renderSection();
    fireEvent.change(screen.getByLabelText(/Choose infrastructure nodes/), { target: { value: 'manual' } });
    await waitFor(() => expect(screen.getByTestId('airtime-picker')).toBeTruthy());
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    await act(async () => { await saveBar!.onSave(); });
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Pick 3 to 5'), 'error');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

    fireEvent.click(boxes[2]);
    await act(async () => { await saveBar!.onSave(); });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post).toBeTruthy();
    const body = JSON.parse(post![1].body);
    expect(body).toMatchObject({
      automationAirtimeCutoffSource: 'neighbors',
      automationAirtimeCutoffNeighborMode: 'manual',
      automationAirtimeCutoffNeighborSampleCount: '3',
      automationAirtimeCutoffNeighborNodes: JSON.stringify([0xa1, 0xa2, 0xa3]),
    });
  });

  it('says when local ChUtil is used because it is higher, and names skipped picks', async () => {
    settings.automationAirtimeCutoffNeighborMode = 'manual';
    settings.automationAirtimeCutoffNeighborNodes = JSON.stringify([0xa1, 0xa2, 0xb9]);
    status = {
      ...status,
      channelUtilization: 31,
      sampleCount: 2,
      targetCount: 3,
      neighborAverage: 18,
      localChannelUtilization: 31,
      localUsed: 'higher_than_neighbors',
      neighborMode: 'manual',
      skipped: [{ nodeNum: 0xb9, nodeId: '!000000b9', longName: 'Far Router', shortName: null, reason: 'mqtt' }],
    };
    await renderSection();
    await waitFor(() => expect(screen.getByTestId('airtime-fill-line')).toBeTruthy());
    expect(screen.getByTestId('airtime-fill-line').textContent).toBe(
      '2 of 3 infrastructure nodes qualify; using local 31% (higher than their average 18%).',
    );
    expect(screen.getByTestId('airtime-skipped-line').textContent).toBe('Skipped: Far Router (heard over MQTT)');
    // The banner names the source honestly: local, not neighbour-averaged.
    expect(screen.getByText(/Automations active — local Channel Utilization 31%/)).toBeTruthy();
    // A saved pick that is no longer offered (e.g. now MQTT-only) shows so it can be removed.
    await waitFor(() => expect(screen.getByText('not eligible now (skipped)')).toBeTruthy());
  });

  it('says when no infrastructure node qualifies and local stands in', async () => {
    status = { ...status, channelUtilization: 40, sampleCount: 0, targetCount: 3, neighborAverage: null, localChannelUtilization: 40, localUsed: 'no_neighbors', gated: true };
    await renderSection();
    await waitFor(() => expect(screen.getByTestId('airtime-fill-line')).toBeTruthy());
    expect(screen.getByTestId('airtime-fill-line').textContent).toBe('0 of 3 infrastructure nodes qualify; using local 40%.');
  });
});
