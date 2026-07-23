/**
 * Shared node/traceroute/map orchestration for the (Meshtastic) source view.
 *
 * Extracted from App.tsx (#3962 Phase 5.4 PR4, task54_spec.md §3/§7) as part
 * of migrating the `nodes` tab to a route. `nodes` is the default/index tab
 * and is entangled with the map + traceroute machinery — this hook is the
 * "shared-orchestration core" the census in task54_spec.md §1.3 describes:
 * `processedNodes` (filter/sort), marker refs, traceroute path rendering,
 * and the favorite/delete/purge handlers.
 *
 * These values are consumed by the `nodes` route (NodesTab) AND by several
 * not-yet-migrated surfaces still living in App.tsx (the inline `messages`
 * tab block, the global PurgeDataModal, and NodePopup) — App destructures
 * this hook's return value into the same local names those consumers
 * already close over, so nothing downstream needs to change.
 *
 * Most inputs come from the same React Contexts App.tsx already reads
 * (useSource/useData/useMapContext/useSettings/useUI/useMessaging) — calling
 * them again here is a plain second `useContext` subscriber, not a
 * duplicate side effect, so behavior is unchanged. The handful of genuinely
 * App-local values (baseUrl, authFetch, refetchPoll, nodeFilters,
 * mergedThemeColors, and two modal/route-segment setters) are passed in
 * explicitly.
 */

import React, { useCallback, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type L from 'leaflet';

import { DeviceInfo } from '../types/device';
import { SortField, SortDirection, NodeFilters } from '../types/ui';
import { useSettings } from '../contexts/SettingsContext';
import { useMapContext } from '../contexts/MapContext';
import { useData } from '../contexts/DataContext';
import { useMessaging } from '../contexts/MessagingContext';
import { useUI } from '../contexts/UIContext';
import { useSource } from '../contexts/SourceContext';
import { useToast } from '../components/ToastContainer';
import { useNodes, useTelemetryNodes, setNodeFieldInCache } from './useServerData';
import { useTraceroutePaths, type ThemeColors } from './useTraceroutePaths';
import { isNodeComplete, getEffectivePosition } from '../utils/nodeHelpers';
import { effectiveMapMaxAgeHours } from '../utils/mapAge';
import { nodePassesTransportFilter, transportCutoffSec } from '../utils/nodeTransport';
import { logger } from '../utils/logger';
import { favoritePendingKey, pendingFavoriteRequests } from '../utils/pendingToggles';

export interface UseSourceViewParams {
  /** The deployment base path — App passes `appBasename` (#3962 5.4 PR8
   *  deleted the App-local detectBaseUrl duplicate; see src/init.ts). */
  baseUrl: string;
  /** App-local useCallback — CSRF-aware fetch wrapper. */
  authFetch: (url: string, options?: RequestInit, retryCount?: number, timeoutMs?: number) => Promise<Response>;
  /** App-local — refetch fn from the already-instantiated usePoll() call. */
  refetchPoll: () => unknown;
  /** App-local useState — advanced node filters (persisted to localStorage). */
  nodeFilters: NodeFilters;
  /** App-local useMemo — theme colors merged with overlay scheme colors. */
  mergedThemeColors: ThemeColors;
  /** App-local useState setter — opens RouteSegmentTraceroutesModal. */
  setSelectedRouteSegment: (segment: { nodeNum1: number; nodeNum2: number } | null) => void;
  /** App-local useState setter — closes PurgeDataModal on delete/purge success. */
  setShowPurgeDataModal: (show: boolean) => void;
}

// Helper function to sort nodes
const sortNodes = (nodes: DeviceInfo[], field: SortField, direction: SortDirection): DeviceInfo[] => {
  return [...nodes].sort((a, b) => {
    let aVal: string | number, bVal: string | number;

    switch (field) {
      case 'longName':
        aVal = a.user?.longName || `Node ${a.nodeNum}`;
        bVal = b.user?.longName || `Node ${b.nodeNum}`;
        break;
      case 'shortName':
        aVal = a.user?.shortName || '';
        bVal = b.user?.shortName || '';
        break;
      case 'id':
        aVal = a.user?.id || a.nodeNum;
        bVal = b.user?.id || b.nodeNum;
        break;
      case 'lastHeard':
        aVal = a.lastHeard || 0;
        bVal = b.lastHeard || 0;
        break;
      case 'snr':
        aVal = a.snr || -999;
        bVal = b.snr || -999;
        break;
      case 'battery':
        aVal = a.deviceMetrics?.batteryLevel || -1;
        bVal = b.deviceMetrics?.batteryLevel || -1;
        break;
      case 'hwModel':
        aVal = a.user?.hwModel || 0;
        bVal = b.user?.hwModel || 0;
        break;
      case 'hops': {
        // For nodes without hop data, use fallback values that push them to bottom
        // Ascending: use 999 (high value = bottom), Descending: use -1 (low value = bottom)
        const noHopFallback = direction === 'asc' ? 999 : -1;
        aVal = a.hopsAway !== undefined && a.hopsAway !== null ? a.hopsAway : noHopFallback;
        bVal = b.hopsAway !== undefined && b.hopsAway !== null ? b.hopsAway : noHopFallback;
        break;
      }
      default:
        return 0;
    }

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      const comparison = aVal.toLowerCase().localeCompare(bVal.toLowerCase());
      return direction === 'asc' ? comparison : -comparison;
    } else {
      const comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return direction === 'asc' ? comparison : -comparison;
    }
  });
};

// Helper function to filter nodes
const filterNodes = (nodes: DeviceInfo[], filter: string): DeviceInfo[] => {
  if (!filter.trim()) return nodes;

  const lowerFilter = filter.toLowerCase();
  return nodes.filter(node => {
    const longName = (node.user?.longName || '').toLowerCase();
    const shortName = (node.user?.shortName || '').toLowerCase();
    const id = (node.user?.id || '').toLowerCase();

    return longName.includes(lowerFilter) || shortName.includes(lowerFilter) || id.includes(lowerFilter);
  });
};

export function useSourceView(params: UseSourceViewParams) {
  const { baseUrl, authFetch, refetchPoll, nodeFilters, mergedThemeColors, setSelectedRouteSegment, setShowPurgeDataModal } = params;

  const { t } = useTranslation();
  const { showToast } = useToast();
  const { sourceId } = useSource();
  const { currentNodeId, connectionStatus } = useData();
  // nodes is sourced from the poll cache (#3962 5.4 PR8 — DataContext no
  // longer mirrors it); queryClient is for the optimistic toggle writes
  // below (setNodeFieldInCache), the query-cache-native replacement for the
  // old setNodes(...) writes.
  const { nodes } = useNodes();
  const queryClient = useQueryClient();
  const { selectedDMNode, setSelectedDMNode } = useMessaging();
  const { maxNodeAgeHours, distanceUnit } = useSettings();
  const {
    activeTab,
    nodesNodeFilter,
    sortField,
    sortDirection,
    setTracerouteLoading,
    showIncompleteNodes,
  } = useUI();
  const {
    showPaths,
    showRoute,
    showMqttNodes,
    showUdpNodes,
    showRfNodes,
    showEstimatedPositions,
    setMapCenterTarget,
    traceroutes,
    selectedNodeId,
    setSelectedNodeId,
    mapZoom,
    mapMaxAgeHours,
  } = useMapContext();
  const { nodesWithTelemetry, nodesWithWeather: nodesWithWeatherTelemetry, nodesWithEstimatedPosition, nodesWithPKC } =
    useTelemetryNodes();

  const markerRefs = useRef<Map<string, L.Marker>>(new Map());

  // Helper to check if we should show cached data
  const shouldShowData = useCallback(() => {
    return connectionStatus === 'connected' || connectionStatus === 'user-disconnected';
  }, [connectionStatus]);

  const handleTraceroute = useCallback(
    async (nodeId: string, channel?: number) => {
      if (connectionStatus !== 'connected') {
        return;
      }

      try {
        // Set loading state
        setTracerouteLoading(nodeId);

        // Convert nodeId to node number
        const nodeNumStr = nodeId.replace('!', '');
        const nodeNum = parseInt(nodeNumStr, 16);

        await authFetch(`${baseUrl}/api/traceroute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ destination: nodeNum, sourceId, ...(channel !== undefined && { channel }) }),
        });

        logger.debug(`🗺️ Traceroute request sent to ${nodeId}`);

        // Poll for traceroute results with increasing delays
        // This provides faster UI feedback instead of waiting for the 5s poll interval
        const pollDelays = [2000, 5000, 10000, 15000]; // 2s, 5s, 10s, 15s
        pollDelays.forEach(delay => {
          setTimeout(() => {
            void refetchPoll();
          }, delay);
        });

        // Clear loading state after 30 seconds
        setTimeout(() => {
          setTracerouteLoading(null);
        }, 30000);
      } catch (error) {
        logger.error('Failed to send traceroute:', error);
        setTracerouteLoading(null);
      }
    },
    [connectionStatus, setTracerouteLoading, authFetch, baseUrl, sourceId, refetchPoll]
  );

  const handleDeleteNode = useCallback(
    async (nodeNum: number) => {
      const node = nodes.find(n => n.nodeNum === nodeNum);
      const nodeName = node?.user?.shortName || node?.user?.longName || `Node ${nodeNum}`;

      if (
        !window.confirm(
          `Are you sure you want to DELETE ${nodeName} from the local database?\n\nThis will remove:\n- The node from the map and node list\n- All messages with this node\n- All traceroutes for this node\n- All telemetry data for this node\n\nThis action cannot be undone.`
        )
      ) {
        return;
      }

      try {
        const response = await authFetch(`${baseUrl}/api/messages/nodes/${nodeNum}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ sourceId }),
        });

        if (response.ok) {
          const data = await response.json();
          showToast(
            t('toast.deleted_node', {
              node: nodeName,
              messages: data.messagesDeleted,
              traceroutes: data.traceroutesDeleted,
              telemetry: data.telemetryDeleted,
            }),
            'success'
          );
          // Close the purge data modal if open
          setShowPurgeDataModal(false);
          // Clear the selected DM node if it's the one being deleted
          const deletedNode = nodes.find(n => n.nodeNum === nodeNum);
          if (deletedNode && selectedDMNode === deletedNode.user?.id) {
            setSelectedDMNode('');
          }
          // Refresh data from backend to ensure consistency
          void refetchPoll();
        } else {
          const errorData = await response.json();
          showToast(t('toast.failed_delete_node', { error: errorData.message || t('errors.unknown') }), 'error');
        }
      } catch (err) {
        showToast(
          t('toast.failed_delete_node', { error: err instanceof Error ? err.message : t('errors.network') }),
          'error'
        );
      }
    },
    [nodes, authFetch, baseUrl, sourceId, showToast, t, setShowPurgeDataModal, selectedDMNode, setSelectedDMNode, refetchPoll]
  );

  const handlePurgeNodeFromDevice = useCallback(
    async (nodeNum: number) => {
      const node = nodes.find(n => n.nodeNum === nodeNum);
      const nodeName = node?.user?.shortName || node?.user?.longName || `Node ${nodeNum}`;

      if (
        !window.confirm(
          `Are you sure you want to PURGE ${nodeName} from BOTH the connected device AND the local database?\n\nThis will:\n- Send an admin command to remove the node from the device NodeDB\n- Remove the node from the map and node list\n- Delete all messages with this node\n- Delete all traceroutes for this node\n- Delete all telemetry data for this node\n\nThis action cannot be undone and affects both the device and local database.`
        )
      ) {
        return;
      }

      try {
        const response = await authFetch(`${baseUrl}/api/messages/nodes/${nodeNum}/purge-from-device`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ sourceId }),
        });

        if (response.ok) {
          const data = await response.json();
          showToast(
            t('toast.purged_node_device', {
              node: nodeName,
              messages: data.messagesDeleted,
              traceroutes: data.traceroutesDeleted,
              telemetry: data.telemetryDeleted,
            }),
            'success'
          );
          // Close the purge data modal if open
          setShowPurgeDataModal(false);
          // Clear the selected DM node if it's the one being deleted
          const purgedNode = nodes.find(n => n.nodeNum === nodeNum);
          if (purgedNode && selectedDMNode === purgedNode.user?.id) {
            setSelectedDMNode('');
          }
          // Refresh data from backend to ensure consistency
          void refetchPoll();
        } else {
          const errorData = await response.json();
          showToast(t('toast.failed_purge_node_device', { error: errorData.message || t('errors.unknown') }), 'error');
        }
      } catch (err) {
        showToast(
          t('toast.failed_purge_node_device', { error: err instanceof Error ? err.message : t('errors.network') }),
          'error'
        );
      }
    },
    [nodes, authFetch, baseUrl, sourceId, showToast, t, setShowPurgeDataModal, selectedDMNode, setSelectedDMNode, refetchPoll]
  );

  // Get processed (filtered and sorted) nodes
  const processedNodes = useMemo((): DeviceInfo[] => {
    const cutoffTime = Date.now() / 1000 - maxNodeAgeHours * 60 * 60;

    // Age filter (favorites are always visible)
    const ageFiltered = nodes.filter(node => {
      if (node.isFavorite) return true;
      if (!node.lastHeard) return false;
      return node.lastHeard >= cutoffTime;
    });

    // Only apply nodesNodeFilter when Nodes tab is active
    // Messages tab will apply its own messagesNodeFilter
    const textFiltered = activeTab === 'nodes' ? filterNodes(ageFiltered, nodesNodeFilter) : ageFiltered;

    // Apply advanced filters
    const advancedFiltered = textFiltered.filter(node => {
      const nodeId = node.user?.id;
      const isShowMode = nodeFilters.filterMode === 'show';

      // MQTT filter
      if (nodeFilters.showMqtt) {
        const matches = node.viaMqtt;
        if (isShowMode && !matches) return false; // Show mode: exclude non-matches
        if (!isShowMode && matches) return false; // Hide mode: exclude matches
      }

      // Telemetry filter
      if (nodeFilters.showTelemetry) {
        const matches = nodeId && nodesWithTelemetry.has(nodeId);
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Environment metrics filter
      if (nodeFilters.showEnvironment) {
        const matches = nodeId && nodesWithWeatherTelemetry.has(nodeId);
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Power source filter
      const batteryLevel = node.deviceMetrics?.batteryLevel;
      if (nodeFilters.powerSource !== 'both' && batteryLevel !== undefined) {
        const isPowered = batteryLevel === 101;
        if (nodeFilters.powerSource === 'powered' && !isPowered) {
          return false;
        }
        if (nodeFilters.powerSource === 'battery' && isPowered) {
          return false;
        }
      }

      // Position filter
      if (nodeFilters.showPosition) {
        const hasPosition = node.position && node.position.latitude != null && node.position.longitude != null;
        const matches = hasPosition;
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Hops filter (always applies regardless of mode)
      if (node.hopsAway != null) {
        if (node.hopsAway < nodeFilters.minHops || node.hopsAway > nodeFilters.maxHops) {
          return false;
        }
      }

      // PKI filter
      if (nodeFilters.showPKI) {
        const matches = nodeId && nodesWithPKC.has(nodeId);
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Remote Admin filter
      if (nodeFilters.showRemoteAdmin) {
        const matches = !!node.hasRemoteAdmin;
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      /**
       * Unknown nodes filter
       * Identifies nodes that lack both longName and shortName, which are typically
       * displayed as "Node 12345678" in the UI. These nodes have only been detected
       * but haven't provided identifying information yet.
       */
      if (nodeFilters.showUnknown) {
        const hasLongName = node.user?.longName && node.user.longName.trim() !== '';
        const hasShortName = node.user?.shortName && node.user.shortName.trim() !== '';
        const isUnknown = !hasLongName && !hasShortName;
        const matches = isUnknown;
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Ignored nodes filter - hide ignored nodes by default
      // When showIgnored is false (default): hide ignored nodes
      // When showIgnored is true: show ignored nodes
      if (!nodeFilters.showIgnored && node.isIgnored) {
        return false;
      }

      // Favorite locked filter
      if (nodeFilters.showFavoriteLocked) {
        const matches = !!node.favoriteLocked;
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Device role filter
      if (nodeFilters.deviceRoles.length > 0) {
        const role = typeof node.user?.role === 'number' ? node.user.role : parseInt(node.user?.role || '0');
        const matches = nodeFilters.deviceRoles.includes(role);
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Channel filter
      if (nodeFilters.channels.length > 0) {
        const nodeChannel = node.channel ?? -1;
        const matches = nodeFilters.channels.includes(nodeChannel);
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      return true;
    });

    // Separate favorites from non-favorites
    const favorites = advancedFiltered.filter(node => node.isFavorite);
    const nonFavorites = advancedFiltered.filter(node => !node.isFavorite);

    // Sort each group independently
    const sortedFavorites = sortNodes(favorites, sortField, sortDirection);
    const sortedNonFavorites = sortNodes(nonFavorites, sortField, sortDirection);

    // Concatenate: favorites first, then non-favorites
    return [...sortedFavorites, ...sortedNonFavorites];
  }, [
    nodes,
    maxNodeAgeHours,
    activeTab,
    nodesNodeFilter,
    sortField,
    sortDirection,
    nodeFilters,
    nodesWithTelemetry,
    nodesWithWeatherTelemetry,
    nodesWithPKC,
  ]);

  // Function to center map on a specific node
  const centerMapOnNode = useCallback(
    (node: DeviceInfo) => {
      const effectivePos = getEffectivePosition(node);
      if (effectivePos.latitude != null && effectivePos.longitude != null) {
        setMapCenterTarget([effectivePos.latitude, effectivePos.longitude]);
      }
    },
    [setMapCenterTarget]
  );

  // Function to toggle node favorite status
  const toggleFavorite = useCallback(
    async (node: DeviceInfo, event: React.MouseEvent) => {
      event.stopPropagation(); // Prevent node selection when clicking star

      if (!node.user?.id) {
        logger.error('Cannot toggle favorite: node has no user ID');
        return;
      }

      // Prevent multiple rapid clicks on the same node (scoped to current source)
      const favKey = favoritePendingKey(sourceId, node.nodeNum);
      if (pendingFavoriteRequests.get(favKey) !== undefined) {
        return;
      }

      // Store the original state before any updates
      const originalFavoriteStatus = node.isFavorite;
      const newFavoriteStatus = !originalFavoriteStatus;

      try {
        // Mark this request as pending with the expected new state
        pendingFavoriteRequests.set(favKey, newFavoriteStatus);

        // Optimistically update the UI by writing straight into the poll
        // query cache. useNodes() re-derives (via applyPendingNodeOverrides)
        // on every cache change, so this renders immediately and survives
        // the next poll response until the server catches up.
        setNodeFieldInCache(queryClient, sourceId, node.nodeNum, { isFavorite: newFavoriteStatus });

        // Send update to backend (with device sync enabled by default)
        const response = await authFetch(`${baseUrl}/api/nodes/${node.user.id}/favorite`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            isFavorite: newFavoriteStatus,
            syncToDevice: true, // Enable two-way sync to Meshtastic device
            sourceId,
          }),
        });

        if (!response.ok) {
          if (response.status === 403) {
            showToast(t('toast.insufficient_permissions_favorites'), 'error');
            // Revert to original state using the saved original value
            setNodeFieldInCache(queryClient, sourceId, node.nodeNum, { isFavorite: originalFavoriteStatus });
            return;
          }
          throw new Error('Failed to update favorite status');
        }

        const result = await response.json();

        // Log the result including device sync status
        let statusMessage = `${newFavoriteStatus ? '⭐' : '☆'} Node ${node.user.id} favorite status updated`;
        if (result.deviceSync) {
          if (result.deviceSync.status === 'success') {
            statusMessage += ' (synced to device ✓)';
          } else if (result.deviceSync.status === 'failed') {
            // Only show error for actual failures (not firmware compatibility)
            statusMessage += ` (device sync failed: ${result.deviceSync.error || 'unknown error'})`;
          }
          // 'skipped' status (e.g., pre-2.7 firmware) is not shown to user - logged on server only
        }
        logger.debug(statusMessage);
      } catch (error) {
        logger.error('Error toggling favorite:', error);
        // Revert to original state using the saved original value
        setNodeFieldInCache(queryClient, sourceId, node.nodeNum, { isFavorite: originalFavoriteStatus });
        // Remove from pending on error since we reverted
        pendingFavoriteRequests.delete(favKey);
        showToast(t('toast.failed_update_favorite'), 'error');
      }
      // Note: On success, the polling logic will remove from pendingFavoriteRequests
      // when it detects the server has caught up
    },
    [sourceId, queryClient, authFetch, baseUrl, showToast, t]
  );

  // Function to toggle node favorite lock status
  const toggleFavoriteLock = useCallback(
    async (node: DeviceInfo, event: React.MouseEvent) => {
      event.stopPropagation();

      if (!node.user?.id) {
        logger.error('Cannot toggle favorite lock: node has no user ID');
        return;
      }

      const newLocked = !node.favoriteLocked;

      try {
        // Optimistically update the UI — write straight into the poll query
        // cache (#3962 5.4 PR8); useNodes() picks it up on next render.
        setNodeFieldInCache(queryClient, sourceId, node.nodeNum, { favoriteLocked: newLocked });

        const response = await authFetch(`${baseUrl}/api/nodes/${node.user.id}/favorite-lock`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locked: newLocked, sourceId }),
        });

        if (!response.ok) {
          throw new Error(`Server returned ${response.status}`);
        }

        logger.debug(`${newLocked ? '🔒' : '🔓'} Node ${node.user.id} favorite lock set to: ${newLocked}`);
      } catch (error) {
        logger.error('Error toggling favorite lock:', error);
        // Revert
        setNodeFieldInCache(queryClient, sourceId, node.nodeNum, { favoriteLocked: !newLocked });
        showToast(t('toast.failed_update_favorite_lock', 'Failed to update favorite lock'), 'error');
      }
    },
    [queryClient, authFetch, baseUrl, sourceId, showToast, t]
  );

  // Effective map age cap for traceroute/route-segment visibility (#3322):
  // the Map Features age slider, clamped to [1, maxNodeAgeHours]. null =
  // follow the global setting, so default behavior is unchanged.
  const effectiveMapMaxAge = effectiveMapMaxAgeHours(mapMaxAgeHours, maxNodeAgeHours);

  // Create stable digests of nodes and traceroutes that only change when relevant data changes
  // This prevents unnecessary recalculation of traceroutePathsElements
  // Uses getEffectivePosition to respect position overrides (Issue #1526)
  const nodesPositionDigest = useMemo(() => {
    return nodes.map(n => {
      const effectivePos = getEffectivePosition(n);
      return {
        nodeNum: n.nodeNum,
        position: effectivePos.latitude != null && effectivePos.longitude != null
          ? {
              latitude: effectivePos.latitude,
              longitude: effectivePos.longitude,
            }
          : undefined,
        user: n.user
          ? {
              longName: n.user.longName,
              shortName: n.user.shortName,
              id: n.user.id,
            }
          : undefined,
        viaMqtt: n.viaMqtt ?? false,
      };
    });
  }, [nodes.map(n => {
    const pos = getEffectivePosition(n);
    return `${n.nodeNum}-${pos.latitude}-${pos.longitude}-${n.viaMqtt ? '1' : '0'}`;
  }).join(',')]);

  const traceroutesDigest = useMemo(() => {
    return traceroutes.map(tr => ({
      fromNodeNum: tr.fromNodeNum,
      toNodeNum: tr.toNodeNum,
      fromNodeId: tr.fromNodeId,
      toNodeId: tr.toNodeId,
      route: tr.route,
      routeBack: tr.routeBack,
      snrTowards: tr.snrTowards,
      snrBack: tr.snrBack,
      timestamp: tr.timestamp,
      createdAt: tr.createdAt,
    }));
  }, [
    traceroutes
      .map(tr => `${tr.fromNodeNum}-${tr.toNodeNum}-${tr.route}-${tr.routeBack}-${tr.timestamp || tr.createdAt}`)
      .join(','),
  ]);

  // Traceroute paths rendering - extracted to useTraceroutePaths hook
  const tracerouteCallbacks = useMemo(
    () => ({
      onSelectNode: (nodeId: string, position: [number, number]) => {
        setSelectedNodeId(nodeId);
        setMapCenterTarget(position);
      },
      onSelectRouteSegment: (nodeNum1: number, nodeNum2: number) => {
        setSelectedRouteSegment({ nodeNum1, nodeNum2 });
      },
    }),
    [setSelectedNodeId, setMapCenterTarget, setSelectedRouteSegment]
  );

  // Compute visible node numbers for neighbor-info line and traceroute path filtering.
  // Must mirror the per-marker filter in NodesTab so that lines are hidden whenever
  // their endpoint nodes are hidden (Issues #1102, #3147).
  const visibleNodeNums = useMemo(() => {
    // #4240: one clock read per recompute. Deliberately computed INSIDE the memo
    // rather than listed as a dependency — a fresh timestamp every render would
    // invalidate this memo on every render.
    const transportCutoff = transportCutoffSec(effectiveMapMaxAge);
    const visibleNodes = processedNodes.filter(node => {
      if (!node.position?.latitude || !node.position?.longitude) return false;
      // #4162/#3549: "Hide from Map" suppresses the marker (NodesTab drops it
      // at nodesWithPosition), so it must also drop from this visible set —
      // otherwise route-segment / neighbor lines dangle to a marker-less node.
      if (node.hideFromMap) return false;
      if (!nodePassesTransportFilter(node, { showRfNodes, showUdpNodes, showMqttNodes }, transportCutoff)) return false;
      if (!showIncompleteNodes && !isNodeComplete(node)) return false;
      if (!showEstimatedPositions && node.user?.id && nodesWithEstimatedPosition.has(node.user.id)) return false;
      return true;
    });
    return new Set(visibleNodes.map(n => n.nodeNum));
  }, [processedNodes, showRfNodes, showUdpNodes, showMqttNodes, showIncompleteNodes, showEstimatedPositions, nodesWithEstimatedPosition, effectiveMapMaxAge]);

  const { traceroutePathsElements, selectedNodeTraceroute, tracerouteNodeNums, tracerouteBounds } = useTraceroutePaths({
    showPaths,
    showRoute,
    selectedNodeId,
    currentNodeId,
    nodesPositionDigest,
    traceroutesDigest,
    distanceUnit,
    maxNodeAgeHours: effectiveMapMaxAge,
    themeColors: mergedThemeColors,
    callbacks: tracerouteCallbacks,
    visibleNodeNums,
    mapZoom,
  });

  return {
    processedNodes,
    shouldShowData,
    centerMapOnNode,
    toggleFavorite,
    toggleFavoriteLock,
    markerRefs,
    traceroutePathsElements,
    selectedNodeTraceroute,
    visibleNodeNums,
    tracerouteNodeNums,
    tracerouteBounds,
    handleTraceroute,
    handleDeleteNode,
    handlePurgeNodeFromDevice,
  };
}
