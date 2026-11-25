/**
 * @vitest-environment jsdom
 *
 * Coverage Report Walkabout view (#5891 P2, spec §2.13 / §4.3).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../../contexts/authContextObject';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/SettingsContext', () => ({ useSettings: () => ({ distanceUnit: 'km' }) }));

const useCoverageReceivers = vi.fn();
const useCoverageSenders = vi.fn();
const useCoverageReceptions = vi.fn();
vi.mock('../../hooks/useCoverageData', () => ({
  useCoverageReceivers: (...a: unknown[]) => useCoverageReceivers(...a),
  useCoverageSenders: (...a: unknown[]) => useCoverageSenders(...a),
  useCoverageReceptions: (...a: unknown[]) => useCoverageReceptions(...a),
}));
vi.mock('../../hooks/useCoverageSurveys', () => ({
  useCoverageSurveys: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
}));
vi.mock('./CoverageSurveyBar', () => ({ CoverageSurveyBar: () => <div data-testid="survey-bar-stub" /> }));
vi.mock('./CoverageMap', () => ({ CoverageMap: () => <div data-testid="coverage-map-stub" /> }));
vi.mock('./CoverageSummaryPanel', () => ({ CoverageSummaryPanel: () => <div data-testid="summary-stub" /> }));
vi.mock('./CoverageDistanceChart', () => ({ CoverageDistanceChart: () => <div data-testid="distance-stub" /> }));
vi.mock('./CoverageExportButtons', () => ({ CoverageExportButtons: () => <div data-testid="export-stub" /> }));

const useWalkaboutSources = vi.fn();
const useWalkaboutSessions = vi.fn();
vi.mock('../../hooks/useWalkabout', () => ({
  useWalkaboutSources: (...a: unknown[]) => useWalkaboutSources(...a),
  useWalkaboutSessions: (...a: unknown[]) => useWalkaboutSessions(...a),
}));

const hexMap = vi.fn();
vi.mock('./walkaboutHexMapLazy', () => ({
  WalkaboutHexMapLazy: (props: unknown) => {
    hexMap(props);
    return <div data-testid="hex-map-stub" />;
  },
}));

import CoverageReport from './CoverageReport';

const NOW = 1_700_000_000_000;
const SOURCES = [
  { id: 'a', name: 'Alpha', type: 'meshtastic_tcp', enabled: true },
  { id: 'q', name: 'Feed', type: 'mqtt_broker', enabled: true },
];
const SESSIONS = [
  { id: 's-in', name: 'Loop', startedAt: NOW - 3_600_000, endedAt: NOW - 1_800_000, endsAt: NOW },
  { id: 's-old', name: 'Ancient', startedAt: NOW - 90 * 86_400_000, endedAt: NOW - 89 * 86_400_000, endsAt: NOW },
];
const item = (id: number) => ({
  id, sourceId: 'a', protocol: 'meshtastic', receiverKind: 'local', receiverId: '!aaaaaaaa',
  receiverNodeNum: 1, receiverLatitude: 1, receiverLongitude: 1, senderId: '!bbbbbbbb', senderNodeNum: 2,
  packetKey: String(id), packetId: id, pathKey: 'r0:h0', latitude: 1, longitude: 1, altitude: null,
  precisionBits: null, snr: 5, rssi: -80, hopStart: 0, hopLimit: 0, hopsAway: 0, relayNode: 0,
  transportMechanism: null, channel: 0, rxTime: 1, receivedAt: NOW - id,
});

function renderReport(opts: { authenticated: boolean; readable?: string[] } = { authenticated: true }) {
  const readable = opts.readable ?? ['a'];
  const auth = {
    authStatus: { authenticated: opts.authenticated },
    hasPermission: (_r: string, _a: string, o?: { sourceId?: string }) => readable.includes(o?.sourceId ?? ''),
  };
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={auth as never}>
        <CoverageReport />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}
const lastHex = () => hexMap.mock.calls[hexMap.mock.calls.length - 1][0] as any;
const goWalkabout = () => fireEvent.click(screen.getByTestId('coverage-view-walkabout'));

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  useCoverageReceivers.mockReturnValue({
    data: { receivers: [], retentionDays: 7, mqttSources: [] }, isLoading: false, refetch: vi.fn(),
  });
  useCoverageSenders.mockReturnValue({
    data: { senders: [{ senderId: '!bbbbbbbb', senderNodeNum: 2, longName: 'Sender One', shortName: 'S1', fixCount: 4, lastReceivedAt: 1 }], truncated: false },
    isLoading: false, refetch: vi.fn(),
  });
  useCoverageReceptions.mockReturnValue({
    data: { items: [item(1), item(2)], truncated: false }, isLoading: false, refetch: vi.fn(),
  });
  useWalkaboutSources.mockReturnValue({ data: SOURCES });
  useWalkaboutSessions.mockReturnValue({ data: SESSIONS });
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('CoverageReport Walkabout view', () => {
  it('hides the Walkabout button from an anonymous viewer even with nodes:read', () => {
    renderReport({ authenticated: false, readable: ['a'] });
    expect(screen.queryByTestId('coverage-view-walkabout')).toBeNull();
    expect(useWalkaboutSources).not.toHaveBeenCalled();
  });

  it('hides it from a signed-in user with no readable walkabout source', () => {
    renderReport({ authenticated: true, readable: ['q'] });
    expect(screen.queryByTestId('coverage-view-walkabout')).toBeNull();
  });

  it('shows it for a signed-in reader and swaps the map for the hex map', () => {
    renderReport();
    expect(screen.getByTestId('coverage-map-stub')).toBeTruthy();
    goWalkabout();
    expect(screen.queryByTestId('coverage-map-stub')).toBeNull();
    expect(screen.getByTestId('hex-map-stub')).toBeTruthy();
    expect(screen.queryByTestId('summary-stub')).toBeNull();
    expect(screen.queryByTestId('distance-stub')).toBeNull();
    expect(screen.queryByTestId('export-stub')).toBeNull();
    expect(screen.queryByText('Hops')).toBeNull();
    expect(screen.queryByText('Colour by')).toBeNull();
    expect(screen.getByTestId('coverage-walkabout-hint')).toBeTruthy();
  });

  it('disables the receptions query and drops receiver/empty banners', () => {
    useCoverageReceptions.mockReturnValue({
      data: { items: [], truncated: true }, isLoading: false, refetch: vi.fn(),
    });
    renderReport();
    goWalkabout();
    const call = useCoverageReceptions.mock.calls[useCoverageReceptions.mock.calls.length - 1];
    expect(call[1]).toBe(false);
    expect(screen.queryByText('No RF receptions in this window.')).toBeNull();
    expect(screen.queryByText(/Showing the first/)).toBeNull();
    expect(screen.queryByText('Select at least one receiver.')).toBeNull();
  });

  it('sends a range query from the report window, and the sender as node', async () => {
    const user = userEvent.setup();
    renderReport();
    goWalkabout();
    expect(lastHex()).toMatchObject({
      sourceId: 'a',
      query: { kind: 'range', sinceMs: NOW - 86_400_000, untilMs: NOW, node: undefined },
    });
    await user.click(screen.getByRole('combobox', { name: 'Sender' }));
    await user.click(screen.getByRole('option', { name: /Sender One/ }));
    expect(lastHex().query.node).toBe('!bbbbbbbb');
    expect(lastHex().fitKey).toBe('a|24h|!bbbbbbbb');
  });

  it('lists only sessions overlapping the window, and picking one sends a session query', () => {
    renderReport();
    goWalkabout();
    const opts = Array.from(screen.getByTestId('coverage-walkabout-session').querySelectorAll('option')).map((o) => o.textContent);
    expect(opts).toEqual(['All sessions in range', 'Loop']);
    fireEvent.change(screen.getByTestId('coverage-walkabout-session'), { target: { value: 's-in' } });
    expect(lastHex().query).toEqual({ kind: 'session', sessionId: 's-in', node: undefined });
    expect(lastHex().fitKey).toBe('a|s-in|');
  });

  it('returning to Dots re-enables the receptions query', () => {
    renderReport();
    goWalkabout();
    fireEvent.click(screen.getByRole('button', { name: 'Dots' }));
    const call = useCoverageReceptions.mock.calls[useCoverageReceptions.mock.calls.length - 1];
    expect(call[1]).toBe(true);
    expect(screen.getByTestId('coverage-map-stub')).toBeTruthy();
  });
});
