/**
 * Tests for useSourceView — the shared node/traceroute/map orchestration
 * hook extracted from App.tsx (#3962 5.4 PR4).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type React from 'react';
import type { DeviceInfo } from '../types/device';
import type { NodeFilters } from '../types/ui';
import { pendingFavoriteRequests } from '../utils/pendingToggles';

const mockUseSource = vi.fn();
const mockUseData = vi.fn();
const mockUseMessaging = vi.fn();
const mockUseSettings = vi.fn();
const mockUseUI = vi.fn();
const mockUseMapContext = vi.fn();
const mockUseTelemetryNodes = vi.fn();
const mockUseToast = vi.fn();
const mockUseTraceroutePaths = vi.fn();

vi.mock('../contexts/SourceContext', () => ({ useSource: () => mockUseSource() }));
vi.mock('../contexts/DataContext', () => ({ useData: () => mockUseData() }));
vi.mock('../contexts/MessagingContext', () => ({ useMessaging: () => mockUseMessaging() }));
vi.mock('../contexts/SettingsContext', () => ({ useSettings: () => mockUseSettings() }));
vi.mock('../contexts/UIContext', () => ({ useUI: () => mockUseUI() }));
vi.mock('../contexts/MapContext', () => ({ useMapContext: () => mockUseMapContext() }));
vi.mock('./useServerData', () => ({ useTelemetryNodes: () => mockUseTelemetryNodes() }));
vi.mock('../components/ToastContainer', () => ({ useToast: () => mockUseToast() }));
vi.mock('./useTraceroutePaths', () => ({
  useTraceroutePaths: (params: unknown) => mockUseTraceroutePaths(params),
}));

import { useSourceView, type UseSourceViewParams } from './useSourceView';

function makeNode(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    nodeNum: 100,
    user: { id: '!64', longName: 'Node A', shortName: 'NDA' },
    lastHeard: Math.floor(Date.now() / 1000),
    isFavorite: false,
    viaMqtt: false,
    ...overrides,
  } as DeviceInfo;
}

const defaultNodeFilters: NodeFilters = {
  filterMode: 'show',
  showMqtt: false,
  showTelemetry: false,
  showEnvironment: false,
  powerSource: 'both',
  showPosition: false,
  minHops: 0,
  maxHops: 99,
  showPKI: false,
  showRemoteAdmin: false,
  showUnknown: false,
  showIgnored: false,
  showFavoriteLocked: false,
  deviceRoles: [],
  channels: [],
};

function baseParams(overrides: Partial<UseSourceViewParams> = {}): UseSourceViewParams {
  return {
    baseUrl: 'http://localhost:3001',
    authFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    refetchPoll: vi.fn(),
    nodeFilters: defaultNodeFilters,
    mergedThemeColors: {
      mauve: '#cba6f7',
      red: '#f38ba8',
      blue: '#89b4fa',
      overlay0: '#6c7086',
    },
    setSelectedRouteSegment: vi.fn(),
    setShowPurgeDataModal: vi.fn(),
    ...overrides,
  };
}

describe('useSourceView', () => {
  let nodes: DeviceInfo[];
  let setNodes: ReturnType<typeof vi.fn>;
  let setMapCenterTarget: ReturnType<typeof vi.fn>;
  let setSelectedNodeId: ReturnType<typeof vi.fn>;
  let setTracerouteLoading: ReturnType<typeof vi.fn>;
  let showToast: ReturnType<typeof vi.fn>;
  let setSelectedDMNode: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // pendingFavoriteRequests is a module-level singleton (persists across
    // remounts by design, #4240) — clear the key this suite exercises so
    // tests don't leak state into each other.
    pendingFavoriteRequests.delete('src-1:100');

    nodes = [makeNode()];
    setNodes = vi.fn();
    setMapCenterTarget = vi.fn();
    setSelectedNodeId = vi.fn();
    setTracerouteLoading = vi.fn();
    showToast = vi.fn();
    setSelectedDMNode = vi.fn();

    mockUseSource.mockReturnValue({ sourceId: 'src-1', sourceName: 'Test', sourceType: 'meshtastic_tcp' });
    mockUseData.mockReturnValue({ nodes, setNodes, currentNodeId: '!64', connectionStatus: 'connected' });
    mockUseMessaging.mockReturnValue({ selectedDMNode: null, setSelectedDMNode });
    mockUseSettings.mockReturnValue({ maxNodeAgeHours: 24, distanceUnit: 'metric' });
    mockUseUI.mockReturnValue({
      activeTab: 'nodes',
      nodesNodeFilter: '',
      sortField: 'longName',
      sortDirection: 'asc',
      setTracerouteLoading,
      showIncompleteNodes: true,
    });
    mockUseMapContext.mockReturnValue({
      showPaths: false,
      showRoute: false,
      showMqttNodes: true,
      showUdpNodes: true,
      showRfNodes: true,
      showEstimatedPositions: true,
      setMapCenterTarget,
      traceroutes: [],
      selectedNodeId: null,
      setSelectedNodeId,
      mapZoom: 10,
      mapMaxAgeHours: null,
    });
    mockUseTelemetryNodes.mockReturnValue({
      nodesWithTelemetry: new Set<string>(),
      nodesWithWeather: new Set<string>(),
      nodesWithEstimatedPosition: new Set<string>(),
      nodesWithPKC: new Set<string>(),
    });
    mockUseToast.mockReturnValue({ showToast });
    mockUseTraceroutePaths.mockReturnValue({
      traceroutePathsElements: null,
      selectedNodeTraceroute: null,
      tracerouteNodeNums: null,
      tracerouteBounds: null,
    });
  });

  describe('processedNodes', () => {
    it('filters out stale non-favorite nodes but always keeps favorites', () => {
      const stale = makeNode({ nodeNum: 200, isFavorite: false, lastHeard: 0 });
      const staleFavorite = makeNode({ nodeNum: 300, isFavorite: true, lastHeard: 0 });
      mockUseData.mockReturnValue({
        nodes: [makeNode(), stale, staleFavorite],
        setNodes,
        currentNodeId: '!64',
        connectionStatus: 'connected',
      });

      const { result } = renderHook(() => useSourceView(baseParams()));

      const nodeNums = result.current.processedNodes.map(n => n.nodeNum);
      expect(nodeNums).toContain(100);
      expect(nodeNums).toContain(300); // stale favorite stays
      expect(nodeNums).not.toContain(200); // stale non-favorite is dropped
    });

    it('applies nodesNodeFilter text search only when activeTab is "nodes"', () => {
      const nodeA = makeNode({ nodeNum: 100, user: { id: '!64', longName: 'Alpha', shortName: 'A' } });
      const nodeB = makeNode({ nodeNum: 200, user: { id: '!c8', longName: 'Bravo', shortName: 'B' } });
      mockUseData.mockReturnValue({ nodes: [nodeA, nodeB], setNodes, currentNodeId: '!64', connectionStatus: 'connected' });
      mockUseUI.mockReturnValue({
        activeTab: 'nodes',
        nodesNodeFilter: 'Alpha',
        sortField: 'longName',
        sortDirection: 'asc',
        setTracerouteLoading,
        showIncompleteNodes: true,
      });

      const { result: onNodesTab } = renderHook(() => useSourceView(baseParams()));
      expect(onNodesTab.current.processedNodes.map(n => n.nodeNum)).toEqual([100]);

      mockUseUI.mockReturnValue({
        activeTab: 'messages',
        nodesNodeFilter: 'Alpha',
        sortField: 'longName',
        sortDirection: 'asc',
        setTracerouteLoading,
        showIncompleteNodes: true,
      });
      const { result: onMessagesTab } = renderHook(() => useSourceView(baseParams()));
      // messagesNodeFilter is separate — nodesNodeFilter text search is skipped off the nodes tab
      expect(onMessagesTab.current.processedNodes.map(n => n.nodeNum).sort()).toEqual([100, 200]);
    });

    it('sorts favorites before non-favorites', () => {
      const favorite = makeNode({ nodeNum: 200, isFavorite: true, user: { id: '!c8', longName: 'Zeta', shortName: 'Z' } });
      const nonFavorite = makeNode({ nodeNum: 100, isFavorite: false, user: { id: '!64', longName: 'Alpha', shortName: 'A' } });
      mockUseData.mockReturnValue({ nodes: [nonFavorite, favorite], setNodes, currentNodeId: '!64', connectionStatus: 'connected' });

      const { result } = renderHook(() => useSourceView(baseParams()));
      expect(result.current.processedNodes.map(n => n.nodeNum)).toEqual([200, 100]);
    });
  });

  describe('traceroute selection state transitions', () => {
    it('onSelectRouteSegment (wired into useTraceroutePaths callbacks) calls setSelectedRouteSegment', () => {
      const setSelectedRouteSegment = vi.fn();
      renderHook(() => useSourceView(baseParams({ setSelectedRouteSegment })));

      expect(mockUseTraceroutePaths).toHaveBeenCalledTimes(1);
      const passedParams = mockUseTraceroutePaths.mock.calls[0][0];
      passedParams.callbacks.onSelectRouteSegment(111, 222);

      expect(setSelectedRouteSegment).toHaveBeenCalledWith({ nodeNum1: 111, nodeNum2: 222 });
    });

    it('onSelectNode (wired into useTraceroutePaths callbacks) selects the node and centers the map', () => {
      renderHook(() => useSourceView(baseParams()));

      const passedParams = mockUseTraceroutePaths.mock.calls[0][0];
      passedParams.callbacks.onSelectNode('!abc', [40.1, -75.2]);

      expect(setSelectedNodeId).toHaveBeenCalledWith('!abc');
      expect(setMapCenterTarget).toHaveBeenCalledWith([40.1, -75.2]);
    });

    it('passes visibleNodeNums through to useTraceroutePaths, excluding hidden/incomplete/off-transport nodes', () => {
      const visible = makeNode({ nodeNum: 100, position: { latitude: 40, longitude: -75 } as any });
      const hidden = makeNode({ nodeNum: 200, position: { latitude: 41, longitude: -76 } as any, hideFromMap: true } as any);
      mockUseData.mockReturnValue({ nodes: [visible, hidden], setNodes, currentNodeId: '!64', connectionStatus: 'connected' });

      renderHook(() => useSourceView(baseParams()));

      const passedParams = mockUseTraceroutePaths.mock.calls[0][0];
      expect(passedParams.visibleNodeNums.has(100)).toBe(true);
      expect(passedParams.visibleNodeNums.has(200)).toBe(false);
    });
  });

  describe('centerMapOnNode', () => {
    it('centers the map on the node effective position', () => {
      const { result } = renderHook(() => useSourceView(baseParams()));

      act(() => {
        result.current.centerMapOnNode(makeNode({ position: { latitude: 12.5, longitude: -34.5 } as any } as any));
      });

      expect(setMapCenterTarget).toHaveBeenCalledWith([12.5, -34.5]);
    });
  });

  describe('handleTraceroute', () => {
    it('sets loading state and POSTs to /api/traceroute for the target node', async () => {
      const authFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      const { result } = renderHook(() => useSourceView(baseParams({ authFetch })));

      await act(async () => {
        await result.current.handleTraceroute('!64');
      });

      expect(setTracerouteLoading).toHaveBeenCalledWith('!64');
      expect(authFetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/traceroute',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ destination: 100, sourceId: 'src-1' }),
        })
      );
    });

    it('is a no-op when not connected', async () => {
      mockUseData.mockReturnValue({ nodes, setNodes, currentNodeId: '!64', connectionStatus: 'disconnected' });
      const authFetch = vi.fn();
      const { result } = renderHook(() => useSourceView(baseParams({ authFetch })));

      await act(async () => {
        await result.current.handleTraceroute('!64');
      });

      expect(authFetch).not.toHaveBeenCalled();
      expect(setTracerouteLoading).not.toHaveBeenCalled();
    });
  });

  describe('toggleFavorite pending-request dedup (#4240)', () => {
    it('skips a second toggle while one is already in flight for the same source+node', async () => {
      const authFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      const { result } = renderHook(() => useSourceView(baseParams({ authFetch })));
      const node = makeNode({ nodeNum: 100, isFavorite: false });
      const event = { stopPropagation: vi.fn() } as unknown as React.MouseEvent;

      // Prime the pending map as if a request is already in flight for this source+node.
      pendingFavoriteRequests.set('src-1:100', true);

      await act(async () => {
        await result.current.toggleFavorite(node, event);
      });

      expect(authFetch).not.toHaveBeenCalled();
    });

    it('sends the favorite toggle when no request is pending', async () => {
      const authFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ deviceSync: undefined }) });
      const { result } = renderHook(() => useSourceView(baseParams({ authFetch })));
      const node = makeNode({ nodeNum: 100, isFavorite: false });
      const event = { stopPropagation: vi.fn() } as unknown as React.MouseEvent;

      await act(async () => {
        await result.current.toggleFavorite(node, event);
      });

      expect(authFetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/nodes/!64/favorite',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });
});
