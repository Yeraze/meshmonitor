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
 *
 * #5645 adds, to THIS popup only: the node's status message, a relative
 * last-heard line, and keyboard/focus handling. The status is rendered here
 * from the `DeviceInfo` and is kept out of `NodeCardModel` on purpose, so the
 * map popups that share the model cannot pick it up (map status text is a
 * separate follow-up).
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NodePopupState } from '../../types/ui';
import type { DeviceInfo } from '../../types/device';
import type { ResourceType } from '../../types/permission';
import type { DbTraceroute } from '../../services/database';
import { NodeCard } from '../map/popups/NodeCard';
import { IdentityItems, SignalItems, PositionItem, TracerouteBody, NodeActions, type NodeActionSpec } from '../map/popups/sections';
import { toNodeCardModel, useRecentTraceroute } from '../map/popups/nodeCardModel';
import { UiIcon } from '../icons';
import { formatDateTime, formatRelativeTime } from '../../utils/datetime';
import { computePopupPlacement, POPUP_ANCHOR_GAP, type PopupPlacement } from './popupPlacement';
import styles from './NodePopup.module.css';

/** A node unheard for longer than this gets a dimmed last-heard line. */
const STALE_AFTER_SECONDS = 24 * 60 * 60;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The fixed frame: placement, focus and keyboard (#5645).
 *
 * Mounted only while the popup is open. `useDialogA11y` does not fit here: it
 * locks body scroll and hands focus back on every unmount, and this popup is
 * not modal. A mouse click outside closes it, and that click must keep the
 * focus it lands on. Only Escape returns focus to the trigger.
 */
const NodePopupFrame: React.FC<{
  nodePopup: NodePopupState;
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ nodePopup, label, onClose, children }) => {
  const frameRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<PopupPlacement | null>(null);

  const anchorTop = nodePopup.position.y;
  const anchorBottom = nodePopup.anchorBottom ?? anchorTop;

  const place = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const next = computePopupPlacement({
      anchorTop,
      anchorBottom,
      popupHeight: frame.getBoundingClientRect().height,
      viewportHeight: window.innerHeight,
    });
    setPlacement(prev => (prev && prev.side === next.side && prev.top === next.top ? prev : next));
  }, [anchorTop, anchorBottom]);

  // Measure before paint, so the popup never shows on the wrong side first.
  useLayoutEffect(() => {
    place();
  }, [place]);

  // The card grows and shrinks (tab switch, a status arriving): place again.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => place());
    observer.observe(frame);
    return () => observer.disconnect();
  }, [place]);

  // Move focus into the popup on open, and again when another trigger
  // re-targets an open popup.
  useEffect(() => {
    frameRef.current?.focus({ preventScroll: true });
  }, [nodePopup]);

  // Escape closes and hands focus back to the trigger.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      const trigger = nodePopup.trigger;
      onClose();
      if (trigger && trigger.isConnected) trigger.focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [nodePopup, onClose]);

  // Tab and Shift+Tab stay inside the popup while it is open.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const frame = frameRef.current;
    if (e.key !== 'Tab' || !frame) return;
    const focusable = Array.from(frame.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || active === frame) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={frameRef}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      data-placement={placement?.side ?? 'above'}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        left: nodePopup.position.x,
        // Until the first measure this is the old "above" placement, so a
        // runtime with no layout (tests) renders as before.
        top: placement ? placement.top : anchorTop - POPUP_ANCHOR_GAP,
        transform: placement ? 'translateX(-50%)' : 'translateX(-50%) translateY(-100%)',
        zIndex: 10002, // Above sidebar (10001)
      }}
    >
      {children}
    </div>
  );
};

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
  /**
   * Pre-computed tooltip for disabled TX controls (#4547 Phase 2 WP5). App.tsx
   * picks the MeshCore receive-only wording or the Meshtastic LoRa-config
   * wording based on source type. Optional — falls back to
   * `t('tx_disabled.control_tooltip')` at each call site when omitted, so
   * existing callers/tests are unaffected.
   */
  txDisabledTooltip?: string;
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
  txDisabledTooltip,
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

  // Status is free text from someone else's radio. React renders it as text,
  // and it gets no alert styling whatever it says or starts with (#5645).
  const status = node.nodeStatus || '';

  const lastHeardMs = model.lastHeard != null ? model.lastHeard * 1000 : null;
  const isStale = model.lastHeard != null && Date.now() / 1000 - model.lastHeard > STALE_AFTER_SECONDS;

  return (
    <NodePopupFrame nodePopup={nodePopup} label={model.longName} onClose={onClose}>
      <NodeCard
        model={model}
        className="node-popup-overlay"
        sections={
          <>
            {status && (
              <div className={styles.status} data-testid="popup-node-status">
                <div className={styles.statusLabel}>{t('node_details.status_message', 'Status')}</div>
                <div className={styles.statusText} title={status}>{status}</div>
              </div>
            )}
            <div className="node-popup-grid">
              <IdentityItems model={model} />
              <SignalItems model={model} showAltitude showPluggedIn snrDecimals={1} distanceUnit={distanceUnit} />
              {pos && (
                <PositionItem
                  position={pos}
                  positionTimestamp={model.positionTimestamp ?? undefined}
                  timeFormat={timeFormat}
                  dateFormat={dateFormat}
                />
              )}
            </div>
            {lastHeardMs != null && (
              <div
                className={isStale ? `node-popup-footer ${styles.stale}` : 'node-popup-footer'}
                data-testid="popup-last-heard"
                title={formatDateTime(new Date(lastHeardMs), timeFormat, dateFormat)}
              >
                <span className="node-popup-icon"><UiIcon name="time" /></span>
                {formatRelativeTime(lastHeardMs, timeFormat, dateFormat)}
              </div>
            )}
            {lastHeardMs != null && model.firstHeard != null && (
              <div className="node-popup-footer" data-testid="popup-first-heard">
                <span className="node-popup-icon"><UiIcon name="calendar" /></span>
                {t('node_details.first_heard', 'First Heard')}: {formatDateTime(new Date(model.firstHeard * 1000), timeFormat, dateFormat)}
              </div>
            )}
          </>
        }
        actions={<NodeActions actions={actions} />}
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
            runDisabledReason={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : undefined}
          />
        ) : undefined}
      />
    </NodePopupFrame>
  );
};
