/**
 * DashboardNodePopup — richly formatted marker popup for the Dashboard map.
 *
 * Renders the same Meshtastic-style node card used elsewhere in the app
 * (reusing the `.node-popup-*` classes from styles/nodes.css) directly from
 * the flat node shape returned by `/api/sources/:id/nodes`. Handles both the
 * flat API fields (node.longName, node.role, …) and the nested fallbacks
 * (node.user?.longName, node.position?.altitude, …).
 *
 * On the Unified view each merged node carries a `sources` array describing
 * which configured sources reported it and over which protocol (Meshtastic vs
 * MeshCore); when present it's rendered as a labelled list at the bottom.
 */

import { useDisplaySettings } from '../../contexts/SettingsContext';
import { getHardwareModelName, getRoleName } from '../../utils/nodeHelpers';
import { formatRelativeTime } from '../../utils/datetime';

/** A single source that reported this node, attached by mergeUnifiedSourceData. */
export interface NodeSourceRef {
  sourceId: string;
  sourceName: string;
  protocol: 'Meshtastic' | 'MeshCore';
}

interface DashboardNodePopupProps {
  node: any;
  pos: { lat: number; lng: number };
  /**
   * Called when the user clicks one of the "seen by" source rows. The Unified
   * map uses this to jump to that source's Node Details view for this node.
   */
  onSourceSelect?: (source: NodeSourceRef, nodeId: string | undefined) => void;
}

/** Coerce a field that may live on the flat node or its nested `user`. */
function pick<T>(node: any, flatKey: string, userKey: string): T | undefined {
  const flat = node?.[flatKey];
  if (flat !== undefined && flat !== null) return flat as T;
  const nested = node?.user?.[userKey];
  return nested === null ? undefined : (nested as T | undefined);
}

export default function DashboardNodePopup({ node, pos, onSourceSelect }: DashboardNodePopupProps) {
  const { timeFormat, dateFormat } = useDisplaySettings();

  const longName = pick<string>(node, 'longName', 'longName')
    ?? (typeof node?.nodeNum === 'number' ? `Node ${node.nodeNum}` : 'Unknown');
  const shortName = pick<string>(node, 'shortName', 'shortName');
  const nodeId = pick<string>(node, 'nodeId', 'id');

  const roleRaw = pick<number | string>(node, 'role', 'role');
  const roleName = roleRaw !== undefined ? getRoleName(roleRaw) : null;

  const hwModel = pick<number>(node, 'hwModel', 'hwModel');
  const hwModelName = hwModel !== undefined ? getHardwareModelName(hwModel) : null;

  const hops = typeof node?.hopsAway === 'number' ? node.hopsAway : null;
  const altitude = node?.altitude ?? node?.position?.altitude;
  const snr = typeof node?.snr === 'number' ? node.snr : null;
  const battery = typeof node?.batteryLevel === 'number' ? node.batteryLevel : null;
  const lastHeard = typeof node?.lastHeard === 'number' ? node.lastHeard : null;

  const sources: NodeSourceRef[] | undefined = Array.isArray(node?.sources) ? node.sources : undefined;

  return (
    <div className="node-popup">
      {/* Header */}
      <div
        className="node-popup-header"
        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
      >
        <div
          className="node-popup-title"
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {longName}
        </div>
        {shortName && (
          <div className="node-popup-subtitle" style={{ flexShrink: 0 }}>
            {shortName}
          </div>
        )}
      </div>

      {/* Info grid */}
      <div className="node-popup-content">
        <div className="node-popup-grid">
          {nodeId && (
            <div className="node-popup-item node-popup-item-full">
              <span className="node-popup-icon">🆔</span>
              <span className="node-popup-value">{nodeId}</span>
            </div>
          )}

          {roleName && (
            <div className="node-popup-item">
              <span className="node-popup-icon">👤</span>
              <span className="node-popup-value">{roleName}</span>
            </div>
          )}

          {hops != null && (
            <div className="node-popup-item">
              <span className="node-popup-icon">🔗</span>
              <span className="node-popup-value">{hops} hop{hops !== 1 ? 's' : ''}</span>
            </div>
          )}

          {hwModelName && (
            <div className="node-popup-item node-popup-item-full">
              <span className="node-popup-icon">🖥️</span>
              <span className="node-popup-value">{hwModelName}</span>
            </div>
          )}

          {battery != null && (
            <div className="node-popup-item">
              <span className="node-popup-icon">🔋</span>
              <span className="node-popup-value">{battery}%</span>
            </div>
          )}

          {snr != null && (
            <div className="node-popup-item">
              <span className="node-popup-icon">📶</span>
              <span className="node-popup-value">{snr} dB</span>
            </div>
          )}

          {altitude != null && (
            <div className="node-popup-item">
              <span className="node-popup-icon">⛰️</span>
              <span className="node-popup-value">{altitude}m</span>
            </div>
          )}

          <div className="node-popup-item node-popup-item-full">
            <span className="node-popup-icon">📍</span>
            <span className="node-popup-value">
              {pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}
            </span>
          </div>
        </div>

        {lastHeard != null && (
          <div className="node-popup-footer">
            <span className="node-popup-icon">🕐</span>
            {formatRelativeTime(lastHeard * 1000, timeFormat, dateFormat, true)}
          </div>
        )}

        {/* Unified view: which sources reported this node + protocol. Each row
            links to that source's Node Details view for this node. */}
        {sources && sources.length > 0 && (
          <div className="node-popup-sources">
            <div className="node-popup-sources-title">
              Seen by {sources.length} source{sources.length !== 1 ? 's' : ''}
            </div>
            {sources.map((s) => {
              const clickable = !!onSourceSelect;
              return (
                <button
                  key={s.sourceId}
                  type="button"
                  className="node-popup-source-row node-popup-source-row-button"
                  disabled={!clickable}
                  onClick={clickable ? () => onSourceSelect!(s, nodeId) : undefined}
                  title={clickable ? `Open ${s.sourceName} → Node Details` : undefined}
                >
                  <span className={`node-popup-protocol-badge protocol-${s.protocol.toLowerCase()}`}>
                    {s.protocol}
                  </span>
                  <span className="node-popup-source-name">{s.sourceName}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
