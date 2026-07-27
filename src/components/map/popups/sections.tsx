/**
 * The popup-family section registry (spec §2.2). Each section is a pure,
 * data-driven component that reads a `NodeCardModel` (+ its own props) and
 * emits the exact `.node-popup-*` markup/classes the canonical
 * `.node-popup-grid` card (nodes.css) already defines. Meshtastic vs
 * MeshCore differences are section COMPOSITION (which sections a consumer
 * renders), never branches inside a shared component.
 *
 * `IdentityItems` / `SignalItems` / `PositionItem` / `MeshCoreDetails` render
 * bare `.node-popup-item` fragments — no wrapping grid `<div>` — so a
 * consumer composes them inside its own `<div className="node-popup-grid">`,
 * matching the current markup where the grid is one contiguous block of
 * items.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceInfo } from '../../../types/device';
import type { DbTraceroute } from '../../../services/database';
import { formatDateTime, formatRelativeTime } from '../../../utils/datetime';
import { formatTracerouteRoute } from '../../../utils/traceroute';
import { formatPrecisionAccuracy } from '../../../utils/distance';
import { formatLocationSource } from '../../../utils/nodeHelpers';
import type { TimeFormat, DateFormat } from '../../../contexts/SettingsContext';
import type { NodeCardModel, NodeSourceRef } from './nodeCardModel';
import { UiIcon, type UiIconName } from '../../icons';

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

export interface NodeCardHeaderProps {
  model: NodeCardModel;
}

/** `.node-popup-header` + title + optional shortName badge. Byte-identical
 *  to `MapNodePopupContent`/`DashboardNodePopup`'s header markup (the
 *  canonical chrome per D3 — `NodePopup`'s `<h4>` header loses). */
export const NodeCardHeader: React.FC<NodeCardHeaderProps> = ({ model }) => (
  <div className="node-popup-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
    <div
      className="node-popup-title"
      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
    >
      {model.longName}
    </div>
    {model.shortName && (
      <div className="node-popup-subtitle" style={{ flexShrink: 0 }}>
        {model.shortName}
      </div>
    )}
  </div>
);

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export interface IdentityItemsProps {
  model: NodeCardModel;
  /** DashboardNodePopup renders the node-ID item full-width; NodesTab (via
   *  the old `MapNodePopupContent`) does not. Default matches the
   *  non-full-width (NodesTab / NodePopup) behavior since it's the stricter
   *  pixel-identical requirement; Dashboard/MapAnalysis opt into full width. */
  idFullWidth?: boolean;
}

/** Node ID / role / hardware — shown by every Meshtastic consumer. */
export const IdentityItems: React.FC<IdentityItemsProps> = ({ model, idFullWidth = false }) => (
  <>
    {model.nodeId && (
      <div className={`node-popup-item${idFullWidth ? ' node-popup-item-full' : ''}`}>
        <span className="node-popup-icon"><UiIcon name="identity" /></span>
        <span className="node-popup-value">{model.nodeId}</span>
      </div>
    )}
    {model.roleName && (
      <div className="node-popup-item">
        <span className="node-popup-icon"><UiIcon name="user" /></span>
        <span className="node-popup-value">{model.roleName}</span>
      </div>
    )}
    {model.hwModelName && (
      <div className="node-popup-item node-popup-item-full">
        <span className="node-popup-icon"><UiIcon name="monitor" /></span>
        <span className="node-popup-value">{model.hwModelName}</span>
      </div>
    )}
  </>
);

/* ------------------------------------------------------------------ */
/* Signal / power                                                      */
/* ------------------------------------------------------------------ */

export interface SignalItemsProps {
  model: NodeCardModel;
  /** NodePopup (chat overlay) currently shows no hops row at all — pass
   *  `false` to preserve that; every other current renderer shows hops. */
  showHops?: boolean;
  /** Only DashboardNodePopup / (old) MapNodePopupContent show altitude. */
  showAltitude?: boolean;
  /** NodePopup special-cases battery === 101 as "Plugged In"; Dashboard
   *  (canonical) always shows the raw percentage. Off by default. */
  showPluggedIn?: boolean;
  /** R5: NodePopup renders `snr.toFixed(1)`; Dashboard renders the raw
   *  value. Pass a decimal count to round; omit to render raw (Dashboard's
   *  current, byte-identical behavior). */
  snrDecimals?: number;
  /** Distance unit for the position-accuracy readout (#4176). Coerced to
   *  'km'/'mi' for `formatPrecisionAccuracy` ('nm' falls back to metric). */
  distanceUnit?: 'km' | 'mi' | 'nm';
}

/** Hops / SNR / battery / altitude grid items. */
export const SignalItems: React.FC<SignalItemsProps> = ({
  model,
  showHops = true,
  showAltitude = false,
  showPluggedIn = false,
  snrDecimals,
  distanceUnit = 'km',
}) => {
  const { t } = useTranslation();
  const hops = model.hops;
  const hasAltitude = showAltitude && model.altitude != null;
  const showHopsRow = showHops && hops != null && hops < 999;
  const isPluggedIn = showPluggedIn && model.battery === 101;
  // Position accuracy + location source (#4176). Hidden when unset/disabled.
  const precisionBits = model.positionPrecisionBits;
  const showPrecision = precisionBits != null && precisionBits > 0;
  const precisionUnit: 'km' | 'mi' = distanceUnit === 'mi' ? 'mi' : 'km';
  const locationSourceLabel = formatLocationSource(model.positionLocationSource);

  return (
    <>
      {showHopsRow && hops != null && (
        <div className={`node-popup-item${!hasAltitude ? ' node-popup-item-full' : ''}`}>
          <span className="node-popup-icon"><UiIcon name="link" /></span>
          <span className="node-popup-value">
            {t('node_popup.hops', {
              count: hops,
              defaultValue: `${hops} hop${hops !== 1 ? 's' : ''}`,
            })}
          </span>
        </div>
      )}
      {model.snr != null && (
        <div className="node-popup-item">
          <span className="node-popup-icon"><UiIcon name="wifi" /></span>
          <span className="node-popup-value">
            {snrDecimals != null ? model.snr.toFixed(snrDecimals) : model.snr} dB
          </span>
        </div>
      )}
      {model.battery != null && (
        <div className="node-popup-item">
          <span className="node-popup-icon"><UiIcon name={isPluggedIn ? 'batteryCharging' : 'battery'} /></span>
          <span className="node-popup-value">
            {isPluggedIn ? t('node_popup.power_plugged', 'Plugged In') : `${model.battery}%`}
          </span>
        </div>
      )}
      {showAltitude && model.altitude != null && (
        <div className="node-popup-item">
          <span className="node-popup-icon"><UiIcon name="altitude" /></span>
          <span className="node-popup-value">{model.altitude}m</span>
        </div>
      )}
      {showPrecision && (
        <div className="node-popup-item">
          <span className="node-popup-icon" title={t('node_popup.position_accuracy', 'Position accuracy')}><UiIcon name="target" /></span>
          <span className="node-popup-value">{formatPrecisionAccuracy(precisionBits, precisionUnit)}</span>
        </div>
      )}
      {locationSourceLabel && (
        <div className="node-popup-item">
          <span className="node-popup-icon" title={t('node_popup.location_source', 'Location source')}><UiIcon name="configuration" /></span>
          <span className="node-popup-value">{locationSourceLabel}</span>
        </div>
      )}
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Position                                                            */
/* ------------------------------------------------------------------ */

export interface PositionItemProps {
  position: { lat: number; lng: number };
}

/** Full-width lat/lng (5-dp), Dashboard/MapAnalysis only. */
export const PositionItem: React.FC<PositionItemProps> = ({ position }) => (
  <div className="node-popup-item node-popup-item-full">
    <span className="node-popup-icon"><UiIcon name="location" /></span>
    <span className="node-popup-value">
      {position.lat.toFixed(5)}, {position.lng.toFixed(5)}
    </span>
  </div>
);

/* ------------------------------------------------------------------ */
/* Last heard footer                                                   */
/* ------------------------------------------------------------------ */

export interface LastHeardFooterProps {
  /** Epoch SECONDS (matches `NodeCardModel.lastHeard`). */
  lastHeard?: number | null;
  /** 'absolute' = NodesTab/NodePopup's `formatDateTime`; 'relative' =
   *  Dashboard/MapAnalysis's `formatRelativeTime(..., showAbsolute=true)`. */
  mode: 'absolute' | 'relative';
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
}

/** `.node-popup-footer` last-heard/last-seen, shown by every consumer. */
export const LastHeardFooter: React.FC<LastHeardFooterProps> = ({
  lastHeard,
  mode,
  timeFormat,
  dateFormat,
}) => {
  if (lastHeard == null) return null;
  const text = mode === 'relative'
    ? formatRelativeTime(lastHeard * 1000, timeFormat, dateFormat, true)
    : formatDateTime(new Date(lastHeard * 1000), timeFormat, dateFormat);
  return (
    <div className="node-popup-footer">
      <span className="node-popup-icon"><UiIcon name="time" /></span>
      {text}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Sources list (unified view)                                         */
/* ------------------------------------------------------------------ */

export interface SourcesListProps {
  sources?: NodeSourceRef[];
  nodeId?: string;
  onSourceSelect?: (source: NodeSourceRef, nodeId: string | undefined) => void;
}

/** "Seen by N sources" clickable rows, Dashboard/MapAnalysis (unified) only. */
export const SourcesList: React.FC<SourcesListProps> = ({ sources, nodeId, onSourceSelect }) => {
  const { t } = useTranslation();
  if (!sources || sources.length === 0) return null;

  const label = t('node_popup.sources_seen_by', {
    count: sources.length,
    defaultValue: `Seen by ${sources.length} source${sources.length !== 1 ? 's' : ''}`,
  });

  return (
    <div className="node-popup-sources">
      <div className="node-popup-sources-title">{label}</div>
      {sources.map((s) => {
        const clickable = !!onSourceSelect;
        return (
          <button
            key={s.sourceId}
            type="button"
            className="node-popup-source-row node-popup-source-row-button"
            disabled={!clickable}
            onClick={clickable ? () => onSourceSelect!(s, nodeId) : undefined}
            title={clickable ? `Open Node Details for ${s.sourceName}` : undefined}
          >
            <span className={`node-popup-protocol-badge protocol-${s.protocol.toLowerCase()}`}>
              {s.protocol}
            </span>
            <span className="node-popup-source-name">{s.sourceName}</span>
          </button>
        );
      })}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* MeshCore details                                                     */
/* ------------------------------------------------------------------ */

export interface MeshCoreDetailsProps {
  model: NodeCardModel;
}

function hopCountLabel(hops: number | null | undefined): string {
  if (hops === null || hops === undefined) return 'Unknown';
  if (hops === 0) return 'Direct';
  return `${hops} hop${hops > 1 ? 's' : ''}`;
}

/** Hardware literal + Key/RSSI/SNR/Path/Route grid items, MeshCore only. */
export const MeshCoreDetails: React.FC<MeshCoreDetailsProps> = ({ model }) => {
  const { t } = useTranslation();
  const mc = model.meshcore;
  if (!mc) return null;

  return (
    <>
      <div className="node-popup-item node-popup-item-full">
        <span className="node-popup-icon"><UiIcon name="monitor" /></span>
        <span className="node-popup-value">{t('node_popup.meshcore_device', 'MeshCore Device')}</span>
      </div>
      {mc.publicKey && (
        <div className="node-popup-item node-popup-item-full">
          <span className="node-popup-icon"><UiIcon name="identity" /></span>
          <span className="node-popup-value">{mc.publicKey.substring(0, 16)}…</span>
        </div>
      )}
      {mc.rssi != null && (
        <div className="node-popup-item">
          <span className="node-popup-icon"><UiIcon name="radioSignal" /></span>
          <span className="node-popup-value">{mc.rssi} dBm</span>
        </div>
      )}
      {mc.snr != null && (
        <div className="node-popup-item">
          <span className="node-popup-icon"><UiIcon name="wifi" /></span>
          <span className="node-popup-value">{mc.snr} dB</span>
        </div>
      )}
      {mc.pathLen != null && (
        <div className="node-popup-item">
          <span className="node-popup-icon"><UiIcon name="link" /></span>
          <span className="node-popup-value">{hopCountLabel(mc.pathLen)}</span>
        </div>
      )}
      {mc.outPath && (
        <div className="node-popup-item node-popup-item-full">
          <span className="node-popup-icon"><UiIcon name="route" /></span>
          <span className="node-popup-value">{mc.outPath}</span>
        </div>
      )}
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Traceroute body                                                     */
/* ------------------------------------------------------------------ */

export interface TracerouteBodyProps {
  recentTraceroute: DbTraceroute | null;
  nodes: DeviceInfo[];
  distanceUnit: 'km' | 'mi' | 'nm';
  /** Rendered only when both this AND a `recentTraceroute` are present
   *  (matches NodePopup's "View History" button; NodesTab passes nothing). */
  onViewHistory?: () => void;
  /** Rendered whenever provided — consumers gate on permission before
   *  passing it (NodeCard/family sections know nothing about permissions). */
  onRunTraceroute?: () => void;
  running?: boolean;
  runDisabled?: boolean;
  /** Explanatory tooltip for the run button when `runDisabled` is true (e.g. TX-disabled, epic #4294). */
  runDisabledReason?: string;
}

/** `.node-popup-traceroute` fwd/return summary + optional History/Run buttons. */
export const TracerouteBody: React.FC<TracerouteBodyProps> = ({
  recentTraceroute,
  nodes,
  distanceUnit,
  onViewHistory,
  onRunTraceroute,
  running = false,
  runDisabled = false,
  runDisabledReason,
}) => {
  const { t } = useTranslation();
  return (
    <>
      {recentTraceroute ? (
        <div className="node-popup-traceroute">
          <div className="traceroute-header">
            <strong>{t('node_popup.last_traceroute', 'Last Traceroute')}</strong>
            <span className="traceroute-age">
              ({formatRelativeTime(recentTraceroute.timestamp)})
            </span>
          </div>
          {recentTraceroute.route && recentTraceroute.route !== 'null' ? (
            <>
              <div className="traceroute-path">
                <span className="traceroute-label">{t('node_popup.forward_path', 'Forward')}:</span>
                <span className="traceroute-route">
                  {formatTracerouteRoute(
                    recentTraceroute.route,
                    recentTraceroute.snrTowards,
                    recentTraceroute.fromNodeNum,
                    recentTraceroute.toNodeNum,
                    nodes,
                    distanceUnit,
                  )}
                </span>
              </div>
              {recentTraceroute.routeBack && recentTraceroute.routeBack !== 'null' && (
                <div className="traceroute-path">
                  <span className="traceroute-label">{t('node_popup.return_path', 'Return')}:</span>
                  <span className="traceroute-route">
                    {formatTracerouteRoute(
                      recentTraceroute.routeBack,
                      recentTraceroute.snrBack,
                      recentTraceroute.toNodeNum,
                      recentTraceroute.fromNodeNum,
                      nodes,
                      distanceUnit,
                    )}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="traceroute-failed">
              {t('node_popup.traceroute_failed', 'No response received')}
            </div>
          )}
          {onViewHistory && (
            <button
              className="node-popup-btn traceroute-history-btn"
              onClick={onViewHistory}
            >
              {t('node_popup.view_traceroute_history', 'View History')}
            </button>
          )}
        </div>
      ) : (
        <div className="node-popup-no-traceroute">
          {t('node_popup.no_recent_traceroute', 'No recent traceroute data')}
        </div>
      )}

      {onRunTraceroute && (
        <button className="node-popup-btn" onClick={onRunTraceroute} disabled={runDisabled} title={runDisabledReason}>
          {running ? <span className="spinner"></span> : <UiIcon name="radioSignal" />} {t('node_popup.traceroute', 'Traceroute')}
        </button>
      )}
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Actions                                                              */
/* ------------------------------------------------------------------ */

export type NodeActionKind =
  | 'more-details'
  | 'show-on-map'
  | 'copy-nodeinfo'
  | 'navigate-to-dm'
  | 'delete'
  | 'purge';

export interface NodeActionSpec {
  kind: NodeActionKind;
  onClick: () => void;
  disabled?: boolean;
}

interface ActionMeta {
  icon: UiIconName;
  key: string;
  defaultLabel: string;
  /** Which danger-tier class (if any) the button carries, matching
   *  `.popup-danger-btn` (delete) vs `.popup-danger-btn-severe` (purge). */
  danger?: 'red' | 'maroon';
}

const ACTION_META: Record<NodeActionKind, ActionMeta> = {
  'more-details': { icon: 'search', key: 'node_popup.more_details', defaultLabel: 'More Details' },
  'show-on-map': { icon: 'map', key: 'node_popup.show_on_map', defaultLabel: 'Show on Map' },
  'copy-nodeinfo': { icon: 'copy', key: 'nodes.copy_nodeinfo_title', defaultLabel: 'Copy NodeInfo' },
  'navigate-to-dm': { icon: 'search', key: 'node_popup.more_details', defaultLabel: 'More Details' },
  delete: { icon: 'delete', key: 'node_popup.delete_node', defaultLabel: 'Delete', danger: 'red' },
  purge: { icon: 'alert', key: 'node_popup.purge_node', defaultLabel: 'Purge from Device', danger: 'maroon' },
};

export interface NodeActionsProps {
  /** Each consumer supplies exactly its own button set — no boolean soup.
   *  `delete`/`purge` are automatically grouped into a trailing
   *  `.node-popup-danger-actions` block (matching every current renderer);
   *  every other kind renders as a standalone `.node-popup-btn`. */
  actions: NodeActionSpec[];
}

export const NodeActions: React.FC<NodeActionsProps> = ({ actions }) => {
  const { t } = useTranslation();
  const primary = actions.filter(a => a.kind !== 'delete' && a.kind !== 'purge');
  const danger = actions.filter(a => a.kind === 'delete' || a.kind === 'purge');

  return (
    <>
      {primary.map((a) => {
        const meta = ACTION_META[a.kind];
        return (
          <button key={a.kind} className="node-popup-btn" onClick={a.onClick} disabled={a.disabled}>
            <UiIcon name={meta.icon} /> {t(meta.key, meta.defaultLabel)}
          </button>
        );
      })}
      {danger.length > 0 && (
        <div className="node-popup-danger-actions">
          {danger.map((a) => {
            const meta = ACTION_META[a.kind];
            return (
              <button
                key={a.kind}
                className={`node-popup-btn popup-danger-btn${meta.danger === 'maroon' ? ' popup-danger-btn-severe' : ''}`}
                onClick={a.onClick}
                disabled={a.disabled}
              >
                <UiIcon name={meta.icon} /> {t(meta.key, meta.defaultLabel)}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
};
