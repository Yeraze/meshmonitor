/**
 * @vitest-environment jsdom
 *
 * #5685: adding, editing and deleting pins from Map Analysis. Covers the
 * placement flow, the source picker, the channel list following the chosen
 * source, popup actions by permission and lock, and that no write leaves the
 * browser before Save.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider, useMapAnalysisCtx, type PinPlaceMode } from './MapAnalysisContext';
import { usePinAuthoring, preselectPinSource, type PinAuthoring } from './usePinAuthoring';
import MapPinAuthoringOverlay from './MapPinAuthoringOverlay';
import type { Waypoint } from '../../types/waypoint';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

type PinSource = { id: string; name: string };
let waypointSources: PinSource[] = [];
let markerSources: PinSource[] = [];
vi.mock('../../hooks/usePinSources', () => ({
  usePinSources: () => ({ waypointSources, markerSources }),
}));

let localNodeNums: Record<string, number> = {};
vi.mock('../../hooks/useDashboardData', () => ({
  useSourceStatuses: (ids: string[]) =>
    new Map(ids.map((id) => [id, id in localNodeNums ? { sourceId: id, connected: true, nodeNum: localNodeNums[id] } : null])),
}));

// apiService carries the channel reads and every local-marker write.
const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPut = vi.fn();
const apiDelete = vi.fn();
vi.mock('../../services/api', () => ({
  default: {
    setBaseUrl: vi.fn(),
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
    put: (...a: unknown[]) => apiPut(...a),
    delete: (...a: unknown[]) => apiDelete(...a),
  },
}));

const CHANNELS: Record<string, Array<{ id: number; name: string }>> = {
  'radio-a': [{ id: 0, name: 'LongFast' }, { id: 1, name: 'alpha-ops' }],
  'radio-b': [{ id: 0, name: 'MediumFast' }, { id: 2, name: 'bravo-net' }],
};

// useWaypoints talks to the server with fetch: every waypoint write is here.
const fetchMock = vi.fn();
const writes = () => fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') !== 'GET');

let pins: PinAuthoring;
let setMode: (m: PinPlaceMode) => void;
let currentMode: PinPlaceMode;

function Harness({ active2D = true }: { active2D?: boolean }) {
  const ctx = useMapAnalysisCtx();
  setMode = ctx.setPinPlaceMode;
  currentMode = ctx.pinPlaceMode;
  pins = usePinAuthoring(active2D);
  return <MapPinAuthoringOverlay pins={pins} />;
}

function renderHarness(props: { active2D?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MapAnalysisProvider>
        <Harness {...props} />
      </MapAnalysisProvider>
    </QueryClientProvider>,
  );
}

/** Arm placement, then click the map at a spot. */
function place(kind: 'waypoint' | 'marker', lat = 26.5, lon = -80.1) {
  act(() => setMode(kind));
  act(() => pins.pickSpot(lat, lon));
}

const channelSelect = () => screen.getByLabelText('Broadcast channel') as HTMLSelectElement;
const optionTexts = (sel: HTMLSelectElement) => Array.from(sel.options).map((o) => o.textContent);
const sourceSelect = () => document.getElementById('waypoint-sending-source') as HTMLSelectElement | null;
const createButton = () => screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;

const wp = (over: Partial<Waypoint> = {}): Waypoint => ({
  sourceId: 'radio-a', waypointId: 7, ownerNodeNum: 100, latitude: 1, longitude: 2,
  expireAt: null, lockedTo: null, name: 'Camp', description: '', iconCodepoint: null, iconEmoji: null,
  isVirtual: false, channel: 1, rebroadcastIntervalS: null, lastBroadcastAt: null,
  firstSeenAt: 1, lastUpdatedAt: 1,
  ...over,
} as Waypoint);

beforeEach(() => {
  localStorage.clear();
  waypointSources = [{ id: 'radio-a', name: 'Radio A' }, { id: 'radio-b', name: 'Radio B' }];
  markerSources = [...waypointSources, { id: 'broker', name: 'Broker' }];
  localNodeNums = { 'radio-a': 100, 'radio-b': 200 };
  apiGet.mockReset().mockImplementation(async (url: string) => {
    const m = /\/api\/sources\/([^/]+)\/channels$/.exec(url);
    return m ? CHANNELS[decodeURIComponent(m[1])] ?? [] : [];
  });
  apiPost.mockReset().mockResolvedValue({ success: true, data: { id: 1 } });
  apiPut.mockReset().mockResolvedValue({ success: true, data: { id: 1 } });
  apiDelete.mockReset().mockResolvedValue({ success: true });
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 201, json: async () => ({ success: true, data: {} }), text: async () => '' });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('preselectPinSource', () => {
  const a = { id: 'a', name: 'A' };
  const b = { id: 'b', name: 'B' };
  it('picks the only candidate', () => {
    expect(preselectPinSource([a], [])).toBe('a');
    // Even when the map filter hides it: there is nothing else to send from.
    expect(preselectPinSource([a], ['z'])).toBe('a');
  });
  it('picks nothing among several, so the user must choose', () => {
    expect(preselectPinSource([a, b], [])).toBeNull();
    expect(preselectPinSource([a, b], ['a', 'b'])).toBeNull();
  });
  it('picks the one candidate the map filter leaves', () => {
    expect(preselectPinSource([a, b], ['b', 'broker'])).toBe('b');
  });
  it('picks nothing with no candidate', () => {
    expect(preselectPinSource([], [])).toBeNull();
  });
});

describe('placement flow', () => {
  it('shows the hint while armed, opens the waypoint editor at the clicked spot, and disarms', () => {
    renderHarness();
    expect(screen.queryByTestId('pin-placement-hint')).toBeNull();

    act(() => setMode('waypoint'));
    expect(screen.getByTestId('pin-placement-hint')).toHaveTextContent('Nothing is sent until you save');
    expect(pins.placing).toBe('waypoint');
    expect(screen.queryByText('New Waypoint')).toBeNull();

    act(() => pins.pickSpot(26.5, -80.1));
    expect(currentMode).toBeNull();
    expect(screen.queryByTestId('pin-placement-hint')).toBeNull();
    expect(screen.getByText('New Waypoint')).toBeInTheDocument();
    const lat = document.querySelector('input[type="number"][step="0.000001"]') as HTMLInputElement;
    expect(lat.value).toBe('26.5');
  });

  it('cancels from the hint button and from Escape, opening nothing', () => {
    renderHarness();
    act(() => setMode('waypoint'));
    fireEvent.click(within(screen.getByTestId('pin-placement-hint')).getByRole('button'));
    expect(currentMode).toBeNull();

    act(() => setMode('marker'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(currentMode).toBeNull();
    expect(screen.queryByText('New Waypoint')).toBeNull();
    expect(screen.queryByText('New local marker')).toBeNull();
  });

  it('drops an armed tool when the map leaves 2D', () => {
    const { rerender } = renderHarness();
    act(() => setMode('waypoint'));
    expect(pins.placing).toBe('waypoint');
    const qc = new QueryClient();
    rerender(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider><Harness active2D={false} /></MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(pins.placing).toBeNull();
  });

  it('a click with nothing armed opens nothing', () => {
    renderHarness();
    act(() => pins.pickSpot(1, 2));
    expect(screen.queryByText('New Waypoint')).toBeNull();
    expect(screen.queryByText('New local marker')).toBeNull();
  });
});

describe('waypoint source picker', () => {
  it('preselects the source and shows it as text when exactly one can send', async () => {
    waypointSources = [{ id: 'radio-b', name: 'Radio B' }];
    renderHarness();
    place('waypoint');
    expect(sourceSelect()).toBeNull();
    expect(screen.getByTestId('pin-source-fixed')).toHaveTextContent('Radio B');
    expect(createButton().disabled).toBe(false);
    await waitFor(() => expect(optionTexts(channelSelect())).toEqual(['MediumFast (Primary)', 'bravo-net']));
  });

  it('with several, lists only the sending sources, selects none, and keeps Create off until one is chosen', () => {
    renderHarness();
    place('waypoint');
    const sel = sourceSelect()!;
    expect(sel.value).toBe('');
    expect(optionTexts(sel)).toEqual(['Choose a source…', 'Radio A', 'Radio B']);
    expect(createButton().disabled).toBe(true);

    fireEvent.change(sel, { target: { value: 'radio-a' } });
    expect(createButton().disabled).toBe(false);
  });

  it('says which radio sends, and that nothing is sent before Save', () => {
    renderHarness();
    place('waypoint');
    expect(screen.getByTestId('pin-source-picker')).toHaveTextContent('Sending source');
    expect(screen.getByTestId('pin-source-picker')).toHaveTextContent('broadcasts the waypoint to the mesh when you save');
  });

  it('warns when the chosen source is outside the map source filter', () => {
    localStorage.setItem('mapAnalysis.config.v1', JSON.stringify({ version: 1, sources: ['broker'] }));
    renderHarness();
    place('waypoint');
    expect(screen.getByTestId('pin-source-picker')).not.toHaveTextContent('source filter');
    fireEvent.change(sourceSelect()!, { target: { value: 'radio-a' } });
    expect(screen.getByTestId('pin-source-picker')).toHaveTextContent("not in the map's source filter");
  });
});

describe('channel list follows the chosen source (#4341)', () => {
  it('loads no channels before a source is chosen, then that source\'s, then the next one\'s', async () => {
    renderHarness();
    place('waypoint');
    expect(apiGet).not.toHaveBeenCalled();

    fireEvent.change(sourceSelect()!, { target: { value: 'radio-a' } });
    await waitFor(() => expect(optionTexts(channelSelect())).toEqual(['LongFast (Primary)', 'alpha-ops']));
    expect(apiGet).toHaveBeenCalledWith('/api/sources/radio-a/channels');

    fireEvent.change(channelSelect(), { target: { value: '1' } });
    expect(channelSelect().value).toBe('1');

    fireEvent.change(sourceSelect()!, { target: { value: 'radio-b' } });
    await waitFor(() => expect(optionTexts(channelSelect())).toEqual(['MediumFast (Primary)', 'bravo-net']));
    // Slot 1 was radio A's channel; it does not carry over to radio B.
    expect(channelSelect().value).toBe('0');
  });

  it('keeps what was typed when the source changes', async () => {
    renderHarness();
    place('waypoint');
    fireEvent.change(sourceSelect()!, { target: { value: 'radio-a' } });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Trailhead' } });
    fireEvent.change(sourceSelect()!, { target: { value: 'radio-b' } });
    await waitFor(() => expect(optionTexts(channelSelect())).toEqual(['MediumFast (Primary)', 'bravo-net']));
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe('Trailhead');
    const lat = document.querySelector('input[type="number"][step="0.000001"]') as HTMLInputElement;
    expect(lat.value).toBe('26.5');
  });

  it('clears "lock to this node" when the source changes: it would lock to the first radio', () => {
    renderHarness();
    place('waypoint');
    fireEvent.change(sourceSelect()!, { target: { value: 'radio-a' } });
    const lock = () => screen.getByRole('checkbox', { name: /Lock to this node/ }) as HTMLInputElement;
    fireEvent.click(lock());
    expect(lock().checked).toBe(true);
    fireEvent.change(sourceSelect()!, { target: { value: 'radio-b' } });
    expect(lock().checked).toBe(false);
  });

  it('offers "lock to this node" as the chosen source\'s own node', () => {
    renderHarness();
    place('waypoint');
    fireEvent.change(sourceSelect()!, { target: { value: 'radio-b' } });
    // 200 = 0xc8
    expect(screen.getByText(/Lock to this node/)).toHaveTextContent('!000000c8');
  });
});

describe('nothing is sent until Save', () => {
  it('placing, picking a source and filling the form make no write; Create makes exactly one, to the chosen source', async () => {
    renderHarness();
    place('waypoint');
    fireEvent.change(sourceSelect()!, { target: { value: 'radio-b' } });
    await waitFor(() => expect(channelSelect().options.length).toBe(2));
    fireEvent.change(channelSelect(), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Trailhead' } });

    expect(writes()).toHaveLength(0);
    expect(apiPost).not.toHaveBeenCalled();

    fireEvent.click(createButton());
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [url, init] = writes()[0];
    expect(url).toMatch(/\/api\/sources\/radio-b\/waypoints$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ lat: 26.5, lon: -80.1, name: 'Trailhead', channel: 2, virtual: false });
    await waitFor(() => expect(screen.queryByText('New Waypoint')).toBeNull());
    expect(writes()).toHaveLength(1);
  });

  it('Cancel closes the editor with no write', () => {
    waypointSources = [{ id: 'radio-a', name: 'Radio A' }];
    renderHarness();
    place('waypoint');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('New Waypoint')).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it('Create with no source chosen sends nothing', () => {
    renderHarness();
    place('waypoint');
    fireEvent.click(createButton());
    expect(writes()).toHaveLength(0);
  });
});

describe('waypoint popup actions', () => {
  it('gives none for a source that cannot send or that the user cannot write to', () => {
    renderHarness();
    expect(pins.waypointActionsFor({ id: 'broker', name: 'Broker' })).toBeUndefined();
    expect(pins.waypointActionsFor({ id: 'someone-elses-radio' })).toBeUndefined();
    expect(pins.waypointActionsFor({ id: 'radio-a', name: 'Radio A' })).toMatchObject({ canEdit: true, canDelete: true });
  });

  it('honours the lock rule against the waypoint source\'s own node', () => {
    renderHarness();
    const a = pins.waypointActionsFor({ id: 'radio-a', name: 'Radio A' })!;
    expect(a.lockedToOther!(wp({ lockedTo: null }))).toBe(false);
    expect(a.lockedToOther!(wp({ lockedTo: 100 }))).toBe(false); // radio A's own node
    expect(a.lockedToOther!(wp({ lockedTo: 200 }))).toBe(true);
    // The same waypoint on radio B, whose node is 200, is that radio's to change.
    const b = pins.waypointActionsFor({ id: 'radio-b', name: 'Radio B' })!;
    expect(b.lockedToOther!(wp({ sourceId: 'radio-b', lockedTo: 200 }))).toBe(false);
    expect(b.lockedToOther!(wp({ sourceId: 'radio-b', lockedTo: 100 }))).toBe(true);
  });

  it('does not call a waypoint locked while the source\'s own node is unknown (the server decides)', () => {
    localNodeNums = {};
    renderHarness();
    const a = pins.waypointActionsFor({ id: 'radio-a' })!;
    expect(a.lockedToOther!(wp({ lockedTo: 200 }))).toBe(false);
  });

  it('Edit opens the editor on the waypoint\'s own source and channels, and saves with one PATCH', async () => {
    renderHarness();
    act(() => pins.waypointActionsFor({ id: 'radio-a', name: 'Radio A' })!.onEdit!(wp()));
    expect(screen.getByText('Edit Waypoint')).toBeInTheDocument();
    expect(sourceSelect()).toBeNull();
    expect(screen.getByTestId('pin-source-fixed')).toHaveTextContent('Radio A');
    await waitFor(() => expect(optionTexts(channelSelect())).toEqual(['LongFast (Primary)', 'alpha-ops']));
    expect(channelSelect().value).toBe('1');
    expect(writes()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][0]).toMatch(/\/api\/sources\/radio-a\/waypoints\/7$/);
    expect(writes()[0][1].method).toBe('PATCH');
  });

  it('Delete asks first, names the sending source, and sends nothing when declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderHarness();
    const actions = pins.waypointActionsFor({ id: 'radio-a', name: 'Radio A' })!;
    await act(async () => { actions.onDelete!(wp()); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('Delete "Camp"? This will be broadcast to the mesh.');
    expect(confirm.mock.calls[0][0]).toContain('Sending source: Radio A');
    expect(writes()).toHaveLength(0);

    confirm.mockReturnValue(true);
    await act(async () => { actions.onDelete!(wp()); });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][0]).toMatch(/\/api\/sources\/radio-a\/waypoints\/7$/);
    expect(writes()[0][1].method).toBe('DELETE');
  });
});

describe('local markers (never transmitted)', () => {
  it('offers every writable source, MQTT included, and saves to the chosen one without touching the waypoint API', async () => {
    renderHarness();
    place('marker', 10, 20);
    expect(screen.getByText('New local marker')).toBeInTheDocument();
    const sel = document.getElementById('local-marker-source') as HTMLSelectElement;
    expect(optionTexts(sel)).toEqual(['Choose a source…', 'Radio A', 'Radio B', 'Broker']);
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'Mast' } });
    expect(save.disabled).toBe(true);

    fireEvent.change(sel, { target: { value: 'broker' } });
    expect(save.disabled).toBe(false);
    expect(apiPost).not.toHaveBeenCalled();

    fireEvent.click(save);
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost.mock.calls[0][0]).toBe('/api/sources/broker/markers');
    expect(apiPost.mock.calls[0][1]).toMatchObject({ label: 'Mast', latitude: 10, longitude: 20 });
    expect(writes()).toHaveLength(0);
  });

  it('gives popup actions only for sources the user can write to', () => {
    renderHarness();
    expect(pins.markerActionsFor({ id: 'broker' })).toMatchObject({ canEdit: true });
    expect(pins.markerActionsFor({ id: 'read-only-source' })).toBeUndefined();
  });
});
