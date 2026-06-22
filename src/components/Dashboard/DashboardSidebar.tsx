/**
 * DashboardSidebar — lists source cards with status, node counts, and admin kebab menu.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { version } from '../../../package.json';
import type { DashboardSource, SourceStatus, UnifiedStatus } from '../../hooks/useDashboardData';
import { UNIFIED_SOURCE_ID } from '../../hooks/useDashboardData';
import { useAuth } from '../../contexts/AuthContext';

// Persisted, user-resizable sidebar width (issue #3356). The width is stored
// in localStorage so it survives reloads; min/max bounds keep the layout from
// breaking (too narrow to read names, or wide enough to crowd out the map).
const SIDEBAR_WIDTH_KEY = 'dashboard-sidebar-width';
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 240;

const clampSidebarWidth = (w: number): number =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, w));

function loadSidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    const parsed = raw != null ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    // localStorage can throw in private-mode / sandboxed contexts.
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

interface DashboardSidebarProps {
  sources: DashboardSource[];
  statusMap: Map<string, SourceStatus | null>;
  /**
   * Aggregate status from /api/unified/status. When present, drives the
   * Unified card's connection dot. Reachable for unauthenticated viewers,
   * unlike the per-source statusMap which is gated by `sources:read`.
   */
  unifiedStatus?: UnifiedStatus | null;
  nodeCounts: Map<string, number>;
  selectedSourceId: string | null;
  onSelectSource: (id: string) => void;
  isAdmin: boolean;
  isAuthenticated: boolean;
  onAddSource: () => void;
  onEditSource: (id: string) => void;
  onToggleSource: (id: string, enabled: boolean) => void;
  onDeleteSource: (id: string) => void;
  /** Called when user clicks Connect on a source with autoConnect=false (issue #2773). */
  onConnectSource?: (id: string) => void;
  /** Called when user clicks Disconnect (kebab) on a source with autoConnect=false. */
  onDisconnectSource?: (id: string) => void;
  /** Called when user clicks Prune Outside ROI (kebab) on an mqtt_bridge with a geo bbox. */
  onPruneOutsideRoi?: (id: string) => void;
  /** Called when user clicks Resync (kebab) on a connected meshtastic_tcp source (#3122). */
  onResyncSource?: (id: string) => void;
  /** Source IDs currently awaiting a /connect POST — used to show "Connecting..." feedback. */
  connectingIds?: Set<string>;
  /**
   * Called when an admin drag-reorders the source list (issue #3338).
   * Receives the new ordering of real (non-unified) source IDs. When omitted
   * — or when the viewer lacks `sources:write` — cards render without drag
   * handles and the list stays read-only.
   */
  onReorderSources?: (orderedIds: string[]) => void;
  /** Mobile drawer state — on desktop the sidebar is always visible. */
  mobileOpen?: boolean;
  /** Called to close the drawer on mobile (after selecting a source or tapping backdrop). */
  onMobileClose?: () => void;
  /** Opens the News popup when the footer news button is clicked. */
  onNewsClick?: () => void;
}

/**
 * Build the per-source mesh-activity badge shown beside the link-state badge.
 *
 * The link-state badge ("Connected"/"Connecting"/...) only reflects the
 * MeshMonitor↔gateway TCP/serial link. Users on issue #2883 found that
 * misleading because a gateway can be "Connected" while every mesh node it
 * has heard is now stale. This badge complements link state with mesh
 * liveness — total nodes vs. nodes heard in the last ~2h — colored by ratio
 * so a glance tells you how lively the source is right now.
 *
 * Returns `null` when there's nothing useful to show (no nodes ever heard,
 * server didn't include the count, or the source isn't enabled).
 */
function getActivityBadge(
  total: number,
  active: number | undefined,
  t: (key: string, opts?: any) => string,
): { text: string; tone: 'live' | 'partial' | 'idle'; title: string } | null {
  if (active === undefined || total <= 0) return null;
  // Live = >50% of heard nodes still active; partial = some but minority;
  // idle = none heard recently. Picking a ratio rather than absolute count
  // keeps small (<5 node) sources from constantly flipping to "idle" while
  // still flagging large fleets where most nodes have gone quiet.
  const tone: 'live' | 'partial' | 'idle' =
    active === 0 ? 'idle' : active * 2 >= total ? 'live' : 'partial';
  return {
    text: t('source.node_activity', { active, total }),
    tone,
    title: t('source.node_activity_title', { active, total }),
  };
}

function getStatusInfo(
  source: DashboardSource,
  status: SourceStatus | null | undefined,
  t: (key: string) => string,
): { dotClass: string; label: string } {
  if (!source.enabled) {
    return { dotClass: 'disabled', label: t('source.status_disabled') };
  }
  const autoConnectDisabled = (source.config as any)?.autoConnect === false;
  if (autoConnectDisabled && (!status || !status.connected)) {
    // autoConnect=false → source is enabled but manager isn't running until the
    // user explicitly connects (issue #2773). Show a distinct "idle" state
    // instead of a misleading "connecting" dot.
    return { dotClass: 'disabled', label: t('source.status_idle') };
  }
  if (!status) {
    return { dotClass: 'disconnected', label: t('source.status_connecting') };
  }
  if (status.connected) {
    return { dotClass: 'connected', label: t('source.status_connected') };
  }
  return { dotClass: 'connecting', label: t('source.status_connecting') };
}

interface KebabMenuProps {
  sourceId: string;
  sourceEnabled: boolean;
  /** When true, render a "Disconnect" item (manager running + autoConnect=false). */
  canDisconnect?: boolean;
  /** When true, render a "Prune Outside ROI" item (mqtt_bridge with a geo bbox). */
  canPruneOutsideRoi?: boolean;
  /** When true, render a "Resync" item (meshtastic_tcp source currently connected). */
  canResync?: boolean;
  onEdit: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onDisconnect?: (id: string) => void;
  onPruneOutsideRoi?: (id: string) => void;
  onResync?: (id: string) => void;
}

const KebabMenu: React.FC<KebabMenuProps> = ({
  sourceId,
  sourceEnabled,
  canDisconnect,
  canPruneOutsideRoi,
  canResync,
  onEdit,
  onToggle,
  onDelete,
  onDisconnect,
  onPruneOutsideRoi,
  onResync,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      <button
        className="dashboard-kebab-btn"
        aria-label={t('source.options')}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⋮
      </button>
      {open && (
        <div className="dashboard-kebab-menu">
          <button
            className="dashboard-kebab-item"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onEdit(sourceId);
            }}
          >
            {t('source.kebab.edit')}
          </button>
          <button
            className="dashboard-kebab-item"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onToggle(sourceId, !sourceEnabled);
            }}
          >
            {sourceEnabled ? t('source.kebab.disable') : t('source.kebab.enable')}
          </button>
          {canDisconnect && onDisconnect && (
            <button
              className="dashboard-kebab-item"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onDisconnect(sourceId);
              }}
            >
              {t('source.kebab.disconnect')}
            </button>
          )}
          {canPruneOutsideRoi && onPruneOutsideRoi && (
            <button
              className="dashboard-kebab-item"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onPruneOutsideRoi(sourceId);
              }}
            >
              {t('source.kebab.prune_outside_roi')}
            </button>
          )}
          {canResync && onResync && (
            <button
              className="dashboard-kebab-item"
              title={t('source.kebab.resync_help', 'Force a fresh config/NodeDB sync from the device. Respects a 30s cooldown.')}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onResync(sourceId);
              }}
            >
              {t('source.kebab.resync', 'Resync')}
            </button>
          )}
          <button
            className="dashboard-kebab-item danger"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDelete(sourceId);
            }}
          >
            {t('source.kebab.delete')}
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * Wraps a source card with a drag handle so the list can be reordered
 * (issue #3338). Mirrors SortableChannelCard in ChannelsConfigSection — the
 * handle (and only the handle) carries the drag listeners, so clicking the
 * card body still selects the source. The handle stops click propagation so a
 * mis-click on the grip doesn't navigate.
 */
const SortableSourceCard: React.FC<{
  id: string;
  children: React.ReactNode;
}> = ({ id, children }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.8 : 1,
    zIndex: isDragging ? 10 : 'auto',
    position: 'relative',
    display: 'flex',
    alignItems: 'stretch',
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div
        ref={setActivatorNodeRef}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        title="Drag to reorder"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '1.4rem',
          marginLeft: '8px',
          cursor: isDragging ? 'grabbing' : 'grab',
          color: isDragging ? 'var(--ctp-blue)' : 'var(--ctp-overlay1)',
          fontSize: '1.2rem',
          userSelect: 'none',
          flexShrink: 0,
          touchAction: 'none',
        }}
      >
        ⠿
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
};

const DashboardSidebar: React.FC<DashboardSidebarProps> = ({
  sources,
  statusMap,
  unifiedStatus,
  nodeCounts,
  selectedSourceId,
  onSelectSource,
  isAdmin,
  isAuthenticated,
  onAddSource,
  onEditSource,
  onToggleSource,
  onDeleteSource,
  onConnectSource,
  onDisconnectSource,
  onPruneOutsideRoi,
  onResyncSource,
  connectingIds,
  mobileOpen = false,
  onMobileClose,
  onNewsClick,
  onReorderSources,
}) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  // PR-C: kebab visibility (Prune Outside ROI in particular) is gated by
  // per-source `sources:write` rather than the legacy global `isAdmin` prop.
  // Admin short-circuit lives inside hasPermission, so existing admin users
  // still see the menu on every source they have a row for.
  const { hasPermission } = useAuth();

  // On mobile, wrap source selection so the drawer auto-closes after tap.
  const handleSelectSource = (id: string) => {
    onSelectSource(id);
    onMobileClose?.();
  };

  // Drag-to-reorder is admin-only and global (issue #3338). The order column
  // lives server-side; hasPermission('sources','write') without a sourceId is
  // the global-admin check that matches the Add/Edit/Delete gating above.
  const canReorder =
    typeof onReorderSources === 'function' && hasPermission('sources', 'write');

  // Edit mode (issue #3355): drag handles are hidden by default and only
  // appear once the admin explicitly enters edit mode, so the sidebar stays
  // uncluttered for the common case of never reordering. Dragging is live only
  // while BOTH the viewer can reorder AND edit mode is on.
  const [editMode, setEditMode] = useState(false);
  const isReordering = canReorder && editMode;

  // Resizable sidebar (issue #3356). Width lives in component state, is applied
  // to the <aside> via a CSS custom property, and is persisted to localStorage.
  const [sidebarWidth, setSidebarWidth] = useState<number>(loadSidebarWidth);
  // Latest width during a drag, read by the pointerup persist step without
  // re-binding the window listeners on every move.
  const widthRef = useRef(sidebarWidth);
  widthRef.current = sidebarWidth;
  const resizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const persistSidebarWidth = useCallback((w: number) => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
    } catch {
      // Ignore localStorage write failures (private mode / quota).
    }
  }, []);

  const handleResizeMove = useCallback((e: PointerEvent) => {
    const start = resizeStartRef.current;
    if (!start) return;
    setSidebarWidth(clampSidebarWidth(start.startWidth + (e.clientX - start.startX)));
  }, []);

  const handleResizeEnd = useCallback(() => {
    resizeStartRef.current = null;
    window.removeEventListener('pointermove', handleResizeMove);
    window.removeEventListener('pointerup', handleResizeEnd);
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
    persistSidebarWidth(widthRef.current);
  }, [handleResizeMove, persistSidebarWidth]);

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      resizeStartRef.current = { startX: e.clientX, startWidth: widthRef.current };
      window.addEventListener('pointermove', handleResizeMove);
      window.addEventListener('pointerup', handleResizeEnd);
      // Lock the cursor + disable text selection globally for the whole drag,
      // not just over the 5px handle the pointer may slip off.
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [handleResizeMove, handleResizeEnd],
  );

  // Keyboard resize for accessibility — the handle is focusable and responds
  // to arrow keys in 16px steps.
  const handleResizeKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setSidebarWidth((w) => {
        const next = clampSidebarWidth(w - 16);
        persistSidebarWidth(next);
        return next;
      });
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setSidebarWidth((w) => {
        const next = clampSidebarWidth(w + 16);
        persistSidebarWidth(next);
        return next;
      });
    }
  }, [persistSidebarWidth]);

  // Tidy up the window listeners if the sidebar unmounts mid-drag.
  useEffect(() => () => {
    window.removeEventListener('pointermove', handleResizeMove);
    window.removeEventListener('pointerup', handleResizeEnd);
  }, [handleResizeMove, handleResizeEnd]);

  const sensors = useSensors(
    // 5px activation distance so a plain click on the grip still falls through
    // to the card's selection handler (matches the channel-reorder sensor).
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // The Unified virtual source is pinned at the top of the list and is not
  // reorderable — only real backing sources participate in the drag context.
  const reorderableIds = sources
    .filter((s) => s.id !== UNIFIED_SOURCE_ID)
    .map((s) => s.id);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = reorderableIds.indexOf(active.id as string);
    const newIndex = reorderableIds.indexOf(over.id as string);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorderSources?.(arrayMove(reorderableIds, oldIndex, newIndex));
  };

  return (
    <>
      {/* Mobile backdrop — only rendered (via CSS) on small screens when open. */}
      <div
        className={`dashboard-sidebar-backdrop${mobileOpen ? ' open' : ''}`}
        onClick={onMobileClose}
        aria-hidden="true"
      />
      <aside
        className={`dashboard-sidebar${mobileOpen ? ' mobile-open' : ''}`}
        style={{ '--dashboard-sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
      >
      <div className="dashboard-sidebar-header">
        {t('source.header')}
        {isAdmin && (
          <button
            className="dashboard-add-source-btn"
            style={{ marginLeft: 8, padding: '2px 8px', fontSize: 11 }}
            onClick={onAddSource}
          >
            {t('source.add_short')}
          </button>
        )}
        {canReorder && (
          <button
            className="dashboard-add-source-btn"
            style={{ marginLeft: 6, padding: '2px 8px', fontSize: 11 }}
            onClick={() => setEditMode((v) => !v)}
            aria-pressed={editMode}
            title={t('source.edit_mode_help')}
          >
            {editMode ? t('source.edit_mode_done') : t('source.edit_mode')}
          </button>
        )}
      </div>

      {(() => {
        const cards = sources.map((source) => {
        const isUnified = source.id === UNIFIED_SOURCE_ID;
        const status = statusMap.get(source.id);
        const isConnecting = !isUnified && connectingIds?.has(source.id) === true;
        // Unified is a virtual aggregate — show "connected" dot whenever any
        // backing source is connected. Prefer the server-computed
        // `unifiedStatus.connected` and fall back to scanning the per-source
        // statusMap when the poll hasn't landed yet.
        const unifiedConnected = isUnified
          ? unifiedStatus?.connected ??
            Array.from(statusMap.values()).some((s) => s?.connected === true)
          : false;
        const { dotClass, label } = isUnified
          ? unifiedConnected
            ? { dotClass: 'connected', label: t('source.status_connected') }
            : { dotClass: 'disconnected', label: t('source.status_disconnected') }
          : isConnecting
            ? { dotClass: 'connecting', label: t('source.status_connecting') }
            : getStatusInfo(source, status, t);
        const nodeCount = nodeCounts.get(source.id) ?? 0;
        const isSelected = selectedSourceId === source.id;
        // Mesh-activity badge — shown only for enabled sources with a known
        // active count. Unified pulls from the aggregate endpoint so anonymous
        // viewers also see it; per-source uses the gated /status response.
        const activityBadge = source.enabled
          ? isUnified
            ? getActivityBadge(unifiedStatus?.nodeCount ?? nodeCount, unifiedStatus?.activeNodeCount, t)
            : status
              ? getActivityBadge(nodeCount, status.activeNodeCount as number | undefined, t)
              : null
          : null;

        // Show a faint logo watermark behind cards for source types we have
        // brand assets for. Meshtastic sources get the green Meshtastic logo;
        // MeshCore sources get the MeshCore wordmark. Other types render
        // without a watermark.
        const isMeshtastic =
          source.type === 'meshtastic_tcp' || source.type === 'meshtastic_mqtt';
        const isMeshCore = source.type === 'meshcore';
        const isMqttBroker = source.type === 'mqtt_broker';
        const isMqttBridge = source.type === 'mqtt_bridge';
        const cardClassName =
          'dashboard-source-card' +
          (isSelected ? ' selected' : '') +
          (isMeshtastic ? ' has-meshtastic-watermark' : '') +
          (isMeshCore ? ' has-meshcore-watermark' : '') +
          (isMqttBroker ? ' has-mqtt-broker-watermark' : '') +
          (isMqttBridge ? ' has-mqtt-bridge-watermark' : '');

        const card = (
          <div
            key={source.id}
            className={cardClassName}
            onClick={() => handleSelectSource(source.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') handleSelectSource(source.id);
            }}
          >
            <div className="dashboard-source-card-header">
              <span className="dashboard-source-card-name" title={source.name}>
                {source.name}
              </span>
              {!isUnified &&
                source.type !== 'meshtastic_tcp' &&
                source.type !== 'meshtastic_mqtt' &&
                source.type !== 'meshcore' && (
                  <span className="dashboard-source-card-badge">{source.type}</span>
                )}
              {!isUnified && (() => {
                const vn = (source.config as any)?.virtualNode;
                return vn?.enabled ? (
                  <span className="dashboard-source-card-badge" title={t('source.virtual_node_badge_title')}>
                    VN:{vn.port}
                  </span>
                ) : null;
              })()}
              {!isUnified && hasPermission('sources', 'write', { sourceId: source.id }) && (() => {
                // Only show Prune Outside ROI for mqtt_bridge sources that
                // actually have at least one geo bound configured — otherwise
                // the action would no-op server-side.
                const geo = (source.config as any)?.downlinkFilters?.geo;
                const hasGeoBounds =
                  source.type === 'mqtt_bridge' &&
                  geo &&
                  [geo.minLat, geo.maxLat, geo.minLng, geo.maxLng].some((v) => typeof v === 'number');
                return (
                  <KebabMenu
                    sourceId={source.id}
                    sourceEnabled={source.enabled}
                    canDisconnect={
                      (source.config as any)?.autoConnect === false &&
                      status?.connected === true
                    }
                    canPruneOutsideRoi={hasGeoBounds}
                    canResync={
                      source.type === 'meshtastic_tcp' &&
                      status?.connected === true
                    }
                    onEdit={onEditSource}
                    onToggle={onToggleSource}
                    onDelete={onDeleteSource}
                    onDisconnect={onDisconnectSource}
                    onPruneOutsideRoi={onPruneOutsideRoi}
                    onResync={onResyncSource}
                  />
                );
              })()}
            </div>

            <div
              className="dashboard-source-card-status"
              title={status && !status.connected ? (status as { lastError?: string }).lastError ?? undefined : undefined}
            >
              <span className={`dashboard-status-dot ${dotClass}`} />
              <span>{label}</span>
              {activityBadge && (
                <span
                  className={`dashboard-activity-badge dashboard-activity-${activityBadge.tone}`}
                  title={activityBadge.title}
                >
                  {activityBadge.text}
                </span>
              )}
              {(() => {
                // MQTT bridges surface `permissionMessage` on their status
                // when the upstream broker denied subscribe or rejected auth.
                // Shown even when the link is connected — the bridge is up
                // but some capabilities are disabled.
                const permMsg = (status as { permissionMessage?: string | null } | null | undefined)
                  ?.permissionMessage;
                return permMsg ? (
                  <span
                    className="dashboard-permission-badge"
                    title={permMsg}
                    aria-label={permMsg}
                  >
                    ⚠ {t('source.permission_restricted', 'restricted')}
                  </span>
                ) : null;
              })()}
              {(() => {
                // Per-gateway publisher pool status — visible only on
                // mqtt_bridge sources running in per_gateway mode that
                // have actually opened at least one publisher connection.
                // Tooltip lists each publisher's clientId + connected
                // state + publish count so the operator can see at a
                // glance which gateways are reaching the broker.
                if (!isMqttBridge) return null;
                const publishers = (status as {
                  publishers?: Record<string, {
                    connected: boolean;
                    publishes: number;
                    lastError: string | null;
                  }>;
                } | null | undefined)?.publishers;
                if (!publishers) return null;
                const entries = Object.entries(publishers);
                if (entries.length === 0) return null;
                const total = entries.length;
                const connected = entries.filter(([, e]) => e.connected).length;
                const allConnected = connected === total;
                const lines = entries.map(([clientId, e]) => {
                  const state = e.connected ? '✓' : '✗';
                  const errSuffix = e.lastError ? ` — ${e.lastError}` : '';
                  return `${state} ${clientId}  (${e.publishes} pub${e.publishes === 1 ? '' : 's'})${errSuffix}`;
                });
                const title = lines.join('\n');
                return (
                  <span
                    className={
                      'dashboard-publisher-badge' +
                      (allConnected ? '' : ' dashboard-publisher-partial')
                    }
                    title={title}
                    aria-label={title}
                  >
                    {allConnected
                      ? t('source.publishers_all_connected', {
                          defaultValue: '{{count}} gateways',
                          count: total,
                        })
                      : t('source.publishers_partial', {
                          defaultValue: '{{connected}}/{{total}} gateways',
                          connected,
                          total,
                        })}
                  </span>
                );
              })()}
            </div>

            <div className="dashboard-source-card-actions">
              {isAuthenticated ? (
                <span className="dashboard-node-count">{t('source.node_count', { count: nodeCount })}</span>
              ) : (
                <span className="dashboard-lock-icon">🔒</span>
              )}
              {!isUnified && isAdmin && source.enabled &&
                (source.config as any)?.autoConnect === false &&
                !status?.connected &&
                onConnectSource && (() => {
                  const pending = connectingIds?.has(source.id) === true;
                  return (
                    <button
                      className="dashboard-open-btn"
                      disabled={pending}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!pending) onConnectSource(source.id);
                      }}
                      title={t('source.connect_help')}
                    >
                      {pending ? t('source.connecting') : t('source.connect')}
                    </button>
                  );
                })()}
              {!isUnified && source.type !== 'mqtt_broker' && (
                <button
                  className="dashboard-open-btn"
                  disabled={!source.enabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/source/${source.id}`);
                  }}
                >
                  {t('source.open')}
                </button>
              )}
            </div>
          </div>
        );

        // Only real (non-unified) sources are draggable, and only while edit
        // mode is active for a viewer who can reorder. Unified stays pinned at
        // the top.
        return isReordering && !isUnified ? (
          <SortableSourceCard key={source.id} id={source.id}>
            {card}
          </SortableSourceCard>
        ) : card;
        });

        // Wrap the whole list in a drag context only when reordering is
        // enabled. The Unified card sits inside the context but is absent from
        // `items`, so it never participates in the sort.
        return isReordering ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={reorderableIds} strategy={verticalListSortingStrategy}>
              {cards}
            </SortableContext>
          </DndContext>
        ) : (
          cards
        );
      })()}

      <div className="dashboard-sidebar-links">
        <button
          className="dashboard-sidebar-link dashboard-sidebar-link--active"
          onClick={() => navigate('/unified/messages')}
        >
          {t('source.sidebar.unified_messages')}
        </button>
        <button
          className="dashboard-sidebar-link dashboard-sidebar-link--active"
          onClick={() => navigate('/unified/telemetry')}
        >
          {t('source.sidebar.unified_telemetry')}
        </button>
        <button
          className="dashboard-sidebar-link dashboard-sidebar-link--active"
          onClick={() => navigate('/unified/packets')}
        >
          {t('source.sidebar.unified_packets', 'Unified Packets')}
        </button>
        <button
          className="dashboard-sidebar-link dashboard-sidebar-link--active"
          onClick={() => navigate('/analysis')}
        >
          {t('source.sidebar.map_analysis')}
        </button>
        <button
          className="dashboard-sidebar-link dashboard-sidebar-link--active"
          onClick={() => navigate('/reports')}
        >
          {t('source.sidebar.reports', 'Analysis & Reports')}
        </button>
        {hasPermission('automations', 'read') && (
          <button
            className="dashboard-sidebar-link dashboard-sidebar-link--active"
            onClick={() => navigate('/automations')}
          >
            {t('source.sidebar.automations', '🤖 Automation Engine')}
          </button>
        )}
      </div>

      <div className="dashboard-sidebar-footer">
        <span className="dashboard-sidebar-version">v{version}</span>
        <div className="dashboard-sidebar-footer-icons">
          {isAdmin && (
            <>
              <button
                className="dashboard-sidebar-footer-btn"
                title={t('source.sidebar.users')}
                onClick={() => navigate('/users')}
              >
                👥
              </button>
              <button
                className="dashboard-sidebar-footer-btn"
                title={t('source.sidebar.settings')}
                onClick={() => navigate('/settings')}
              >
                ⚙️
              </button>
            </>
          )}
          <button
            className="dashboard-sidebar-footer-btn"
            title={t('source.sidebar.news')}
            onClick={onNewsClick}
            disabled={!onNewsClick}
          >
            📰
          </button>
          <a
            className="dashboard-sidebar-footer-btn"
            href="https://github.com/Yeraze/meshmonitor"
            target="_blank"
            rel="noopener noreferrer"
            title={t('source.sidebar.github')}
          >
            🐙
          </a>
          <a
            className="dashboard-sidebar-footer-btn"
            href="https://meshmonitor.org"
            target="_blank"
            rel="noopener noreferrer"
            title={t('source.sidebar.website')}
          >
            🔗
          </a>
        </div>
      </div>
    </aside>
    {/* Resize handle — a flex sibling between the sidebar and the map so it's
        unaffected by the sidebar's own vertical scroll. Hidden on mobile (the
        sidebar is a fixed-width overlay drawer there). Issue #3356. */}
    <div
      className="dashboard-sidebar-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('source.resize_sidebar')}
      title={t('source.resize_sidebar')}
      tabIndex={0}
      onPointerDown={handleResizeStart}
      onKeyDown={handleResizeKeyDown}
    />
    </>
  );
};

export default DashboardSidebar;
