/**
 * NodePopup — the fixed-position chat overlay opened by clicking a
 * `.sender-dot` in chat (App.tsx). Unlike the other three node-info popups
 * consolidated in #4047 Phase 5, this one is NOT a Leaflet map popup: it's a
 * `position:fixed` div anchored to the click coordinates, with its own
 * click-outside-to-close contract (App.tsx).
 *
 * The fixed-frame wrapper (positioning + click-outside contract) is kept
 * as-is; the body is now a thin composition over the shared popup family
 * (`src/components/map/popups/`, #4047 Phase 5 WP5) — see
 * docs/internal/dev-notes/MAP_CONSOLIDATION_P5_SPEC.md §WP5. The canonical
 * `.node-popup-grid` chrome (nodes.css) wins over the old flat `.route-usage`
 * rows; `NodePopup.css` is deleted and the overlay's frame (background,
 * border, padding, shadow) is salvaged into `.node-popup-overlay` in
 * nodes.css, appended after the base `.node-popup` rules.
 *
 * Per the orchestrator resolution (capability gain, approved), this overlay
 * now also shows the hops row that the pre-Phase-5 version omitted — the
 * default `SignalItems` composition (`showHops` defaults to `true`) is used
 * rather than suppressing it.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { NodePopupState } from '../../types/ui';
import type { DeviceInfo } from '../../types/device';
import type { ResourceType } from '../../types/permission';
import type { DbTraceroute } from '../../services/database';
import { NodeCard } from '../map/popups/NodeCard';
import { IdentityItems, SignalItems, PositionItem, LastHeardFooter, TracerouteBody, NodeActions, type NodeActionSpec } from '../map/popups/sections';
import { toNodeCardModel, useRecentTraceroute } from '../map/popups/nodeCardModel';

interface NodePopupProps {
  nodePopup: NodePopupState | null;
  nodes: DeviceInfo[];
  timeFormat: '12' | '24';
  dateFormat: 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD';
  hasPermission: (resource: ResourceType, action: 'read' | 'write') => boolean;
  onDMNode: (nodeId: string) => void;
  onShowOnMap: (node: DeviceInfo) => void;
  onClose: () => void;
  traceroutes?: DbTraceroute[];
  currentNodeId?: string | null;
  distanceUnit?: 'km' | 'mi' | 'nm';
  onViewTracerouteHistory?: (fromNodeNum: number, toNodeNum: number, fromNodeName: string, toNodeName: string) => void;
  onTraceroute?: (nodeId: string) => void;
  connectionStatus?: string;
  tracerouteLoading?: string | null;
  onDeleteNode?: (nodeNum: number) => void;
  onPurgeNodeFromDevice?: (nodeNum: number) => void;
  currentNodeNum?: number | null;
  /** TX disabled on this source (epic #4294 Phase 2) — ORed into the traceroute run button's disabled state. */
  txDisabled?: boolean;
}

export const NodePopup: React.FC<NodePopupProps> = ({
  nodePopup,
  nodes,
  timeFormat,
  dateFormat,
  hasPermission,
  onDMNode,
  onShowOnMap,
  onClose,
  traceroutes,
  currentNodeId,
  distanceUnit = 'km',
  onViewTracerouteHistory,
  onTraceroute,
  connectionStatus,
  tracerouteLoading,
  onDeleteNode,
  onPurgeNodeFromDevice,
  currentNodeNum,
  txDisabled = false,
}) => {
  const { t } = useTranslation();

  const node = nodePopup ? nodes.find(n => n.user?.id === nodePopup.nodeId) : undefined;

  // Hooks must run unconditionally (before the early return below).
  const recentTraceroute = useRecentTraceroute(traceroutes, currentNodeId, nodePopup?.nodeId);

  if (!nodePopup || !node) return null;

  // Surface the node's reported coordinates as text (issue #4130) so users can
  // eyeball a position (e.g. a bogus 0,0 fix) without opening a map. Reuses the
  // shared popup-family PositionItem/altitude renderers.
  const pos = node.position?.latitude != null && node.position?.longitude != null
    ? { lat: node.position.latitude, lng: node.position.longitude }
    : undefined;

  const model = toNodeCardModel(node, 'meshtastic', {
    nodeFallbackLabel: t('node_popup.node_fallback', { nodeNum: node.nodeNum }),
    pos,
  });

  const hasTracerouteFeatures = hasPermission('traceroute', 'write') && !!onTraceroute;

  const actions: NodeActionSpec[] = [];
  if (node.user?.id && hasPermission('messages', 'read')) {
    actions.push({
      kind: 'more-details',
      onClick: () => {
        onDMNode(node.user!.id);
        onClose();
      },
    });
  }
  if (node.user?.id && node.position?.latitude != null && node.position?.longitude != null) {
    actions.push({
      kind: 'show-on-map',
      onClick: () => {
        onShowOnMap(node);
        onClose();
      },
    });
  }
  if (hasPermission('messages', 'write') && node.nodeNum !== currentNodeNum) {
    if (onDeleteNode) {
      actions.push({
        kind: 'delete',
        onClick: () => {
          onDeleteNode(node.nodeNum);
          onClose();
        },
      });
    }
    if (onPurgeNodeFromDevice && connectionStatus === 'connected') {
      actions.push({
        kind: 'purge',
        onClick: () => {
          onPurgeNodeFromDevice(node.nodeNum);
          onClose();
        },
      });
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        left: nodePopup.position.x,
        top: nodePopup.position.y - 10,
        transform: 'translateX(-50%) translateY(-100%)',
        zIndex: 10002, // Above sidebar (10001)
      }}
    >
      <NodeCard
        model={model}
        className="node-popup-overlay"
        sections={
          <>
            <div className="node-popup-grid">
              <IdentityItems model={model} />
              <SignalItems model={model} showAltitude showPluggedIn snrDecimals={1} distanceUnit={distanceUnit} />
              {pos && <PositionItem position={pos} />}
            </div>
            <LastHeardFooter
              lastHeard={model.lastHeard}
              mode="absolute"
              timeFormat={timeFormat}
              dateFormat={dateFormat}
            />
            <NodeActions actions={actions} />
          </>
        }
        tracerouteBody={hasTracerouteFeatures ? (
          <TracerouteBody
            recentTraceroute={recentTraceroute}
            nodes={nodes}
            distanceUnit={distanceUnit}
            onViewHistory={onViewTracerouteHistory ? () => {
              const localNodeName = nodes.find(n => n.user?.id === currentNodeId)?.user?.longName || currentNodeId || 'Local';
              const remoteNodeName = node.user?.longName || nodePopup.nodeId;
              onViewTracerouteHistory(
                recentTraceroute!.fromNodeNum,
                recentTraceroute!.toNodeNum,
                localNodeName,
                remoteNodeName,
              );
            } : undefined}
            onRunTraceroute={node.user?.id && onTraceroute ? () => onTraceroute(node.user!.id) : undefined}
            running={tracerouteLoading === node.user?.id}
            runDisabled={connectionStatus !== 'connected' || tracerouteLoading === node.user?.id || txDisabled}
            runDisabledReason={txDisabled ? t('tx_disabled.control_tooltip') : undefined}
          />
        ) : undefined}
      />
    </div>
  );
};
