/**
 * DashboardNeighborPopup — popup shown when a neighbor-info link on the
 * Dashboard map is clicked.
 *
 * Neighbor links are deduplicated to a single polyline per unordered node-pair
 * (issue #3777), so a bidirectional A↔B link is drawn once. This popup exposes
 * BOTH directions of the link so the reverse direction's signal data isn't lost
 * to the dedup: the kept record's own `snr`/`lastRxTime` describe the forward
 * direction (node → neighbor), and `reverseSnr`/`reverseLastRxTime` (attached by
 * buildSourceNeighborInfo) describe the reverse direction (neighbor → node).
 *
 * Reuses the `.node-popup-*` classes (styles/nodes.css) for visual parity with
 * the node marker popup.
 */

import { formatRelativeTime } from '../../utils/datetime';

interface DashboardNeighborPopupProps {
  link: any;
}

function formatSnr(snr: unknown): string {
  return typeof snr === 'number' && Number.isFinite(snr) ? `${snr.toFixed(2)} dB` : '—';
}

/**
 * Report time for a direction, formatted relative to now. Uses the NeighborInfo
 * report `timestamp` (milliseconds — the same field the server freshness window
 * divides by 1000). `lastRxTime` is intentionally not used here: its unit is
 * ambiguous across firmware and would risk a wrong "heard" age.
 */
function formatHeard(timestamp: unknown): string | null {
  const ms = typeof timestamp === 'number' && timestamp > 0 ? timestamp : null;
  return ms == null ? null : formatRelativeTime(ms);
}

const TRANSPORT_LABEL: Record<string, string> = {
  rf: 'RF (LoRa)',
  udp: 'UDP',
  mqtt: 'MQTT',
};

export default function DashboardNeighborPopup({ link }: DashboardNeighborPopupProps) {
  const nodeName: string = link?.nodeName ?? link?.nodeId ?? 'Node';
  const neighborName: string = link?.neighborName ?? link?.neighborNodeId ?? 'Neighbor';
  const bidirectional = !!link?.bidirectional;
  const transportClass: string = link?.transportClass ?? 'rf';

  const forwardHeard = formatHeard(link?.timestamp);
  const reverseHeard = formatHeard(link?.reverseTimestamp);
  // The reverse direction's data exists when the link is bidirectional (the dedup
  // dropped that row but stashed its signal on the kept record).
  const hasReverse = bidirectional || link?.reverseSnr != null;

  return (
    <div className="node-popup neighbor-popup">
      <div className="node-popup-header">
        <div className="node-popup-title">
          {nodeName} {bidirectional ? '↔' : '→'} {neighborName}
        </div>
        <span className="node-popup-subtitle">
          {bidirectional ? 'Bidirectional' : 'One-way'} · {TRANSPORT_LABEL[transportClass] ?? transportClass}
        </span>
      </div>

      <div className="node-popup-content">
        <div className="node-popup-grid">
          <div className="node-popup-item node-popup-item-full">
            <span className="node-popup-icon">📶</span>
            <span className="node-popup-value">
              {nodeName} → {neighborName}: SNR {formatSnr(link?.snr)}
              {forwardHeard ? ` · heard ${forwardHeard}` : ''}
            </span>
          </div>

          {hasReverse && (
            <div className="node-popup-item node-popup-item-full">
              <span className="node-popup-icon">📶</span>
              <span className="node-popup-value">
                {neighborName} → {nodeName}: SNR {formatSnr(link?.reverseSnr)}
                {reverseHeard ? ` · heard ${reverseHeard}` : ''}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
