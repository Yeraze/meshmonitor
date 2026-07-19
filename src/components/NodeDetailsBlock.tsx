import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { DeviceInfo } from '../types/device';
import { getHardwareModelName, parseNodeId } from '../utils/nodeHelpers';
import { getDeviceRoleName } from '../utils/deviceRole';
import { getHardwareImageUrl } from '../utils/hardwareImages';
import { formatRelativeTime } from '../utils/datetime';
import { getEffectiveHops } from '../utils/nodeHops';
import { TimeFormat, DateFormat, useSettings } from '../contexts/SettingsContext';
import { useMapContext } from '../contexts/MapContext';
import { useChannels, useDeviceConfig } from '../hooks/useServerData';
import apiService, { SignalTrendResult } from '../services/api';
import './NodeDetailsBlock.css';

interface NodeDetailsBlockProps {
  node: DeviceInfo | null;
  timeFormat?: TimeFormat;
  dateFormat?: DateFormat;
  /**
   * When true (and `onSaveNotes` is provided), the free-text notes field (#3921)
   * is rendered as an editable textarea. Otherwise any existing note is shown
   * read-only.
   */
  canEditNotes?: boolean;
  /** Persist the edited note. Resolves on success, rejects on failure. */
  onSaveNotes?: (notes: string) => Promise<void>;
  /**
   * Active source id. Required to fetch the per-node signal trend badge (#4110);
   * when absent (or a MeshCore/no-source context) the badge is simply omitted.
   */
  sourceId?: string | null;
}

const MAX_NODE_NOTES_LENGTH = 2000;

/** Arrow glyph for a signal trend direction (#4110). */
function signalTrendArrow(trend: SignalTrendResult['trend']): string {
  switch (trend) {
    case 'improving': return '▲';
    case 'degrading': return '▼';
    default: return '→';
  }
}

/**
 * Build a human-readable tooltip summarizing the day-vs-week deltas behind a
 * signal-trend badge (#4110). Kept plain-text so it works as a `title` attr.
 * `translate` is i18next's `t` so the descriptive words are localized (the
 * RSSI/SNR acronyms and dB units are left as-is).
 */
function buildSignalTrendTooltip(
  trend: SignalTrendResult,
  translate: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  const signed = (n: number) => `${n >= 0 ? '+' : ''}${n}`;
  const metricLine = (label: string, m: NonNullable<SignalTrendResult['rssi']>) =>
    translate('node_details.signal_trend_tooltip_metric', {
      label,
      delta: signed(m.delta),
      unit: m.unit,
      recent: m.recent,
      baseline: m.baseline,
      defaultValue: `${label} ${signed(m.delta)} ${m.unit} (24h avg ${m.recent} vs 7d ${m.baseline})`,
    });
  if (trend.rssi) parts.push(metricLine('RSSI', trend.rssi));
  if (trend.snr) parts.push(metricLine('SNR', trend.snr));
  if (trend.noiseFloorRising && trend.noiseFloor) {
    parts.push(translate('node_details.signal_trend_tooltip_noise', {
      delta: signed(trend.noiseFloor.delta),
      unit: trend.noiseFloor.unit,
      defaultValue: `Noise floor rising ${signed(trend.noiseFloor.delta)} ${trend.noiseFloor.unit}`,
    }));
  }
  return parts.join('\n');
}

const NodeDetailsBlock: React.FC<NodeDetailsBlockProps> = ({ node, timeFormat = '24', dateFormat = 'MM/DD/YYYY', canEditNotes = false, onSaveNotes, sourceId }) => {
  const { t } = useTranslation();
  const { channels } = useChannels();
  const { currentNodeId } = useDeviceConfig();
  const { nodeHopsCalculation } = useSettings();
  const { traceroutes } = useMapContext();
  const currentNodeNum = currentNodeId ? parseNodeId(currentNodeId) : null;
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    const stored = localStorage.getItem('nodeDetailsCollapsed');
    return stored === 'true';
  });

  // #3921: editable free-text notes. Draft is kept in local state and only
  // persisted on Save; it re-syncs whenever the selected node (or its stored
  // note) changes.
  const nodeNum = node?.nodeNum;
  const storedNotes = node?.notes ?? '';
  const [notesDraft, setNotesDraft] = useState<string>(storedNotes);
  // Baseline the draft is compared against for the "dirty" check. It tracks the
  // last-persisted value locally so the Save button settles immediately after a
  // successful save, even before the polled `nodes` prop catches up.
  const [notesBaseline, setNotesBaseline] = useState<string>(storedNotes);
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);

  // #4110: derived signal trend / link-attenuation badge. Fetched from the
  // backend (which computes it from stored RSSI/SNR/noise-floor telemetry) when
  // a concrete source is selected. Null while loading or when unavailable.
  // Deliberately fetched once per node selection (not polled): the trend is a
  // day-vs-week aggregate, so sub-session refresh would not change the verdict.
  const [signalTrend, setSignalTrend] = useState<SignalTrendResult | null>(null);
  const nodeIdForTrend = node?.user?.id
    ?? (nodeNum != null ? `!${nodeNum.toString(16).padStart(8, '0')}` : null);

  useEffect(() => {
    localStorage.setItem('nodeDetailsCollapsed', isCollapsed.toString());
  }, [isCollapsed]);

  useEffect(() => {
    // The endpoint requires a sourceId; skip the fetch entirely without one.
    if (!nodeIdForTrend || !sourceId) {
      setSignalTrend(null);
      return;
    }
    let cancelled = false;
    setSignalTrend(null);
    apiService.getSignalTrend(nodeIdForTrend, sourceId)
      .then(result => { if (!cancelled) setSignalTrend(result); })
      .catch(() => { if (!cancelled) setSignalTrend(null); });
    return () => { cancelled = true; };
  }, [nodeIdForTrend, sourceId]);

  // Re-sync draft/baseline whenever the selected node or its stored note changes.
  useEffect(() => {
    setNotesDraft(storedNotes);
    setNotesBaseline(storedNotes);
    setNotesError(null);
  }, [nodeNum, storedNotes]);

  if (!node) {
    return null;
  }

  const notesDirty = notesDraft !== notesBaseline;

  const handleSaveNotes = async () => {
    if (!onSaveNotes || notesSaving || !notesDirty) return;
    setNotesSaving(true);
    setNotesError(null);
    try {
      await onSaveNotes(notesDraft);
      setNotesBaseline(notesDraft);
    } catch (err) {
      setNotesError(err instanceof Error ? err.message : t('node_details.notes_error', 'Failed to save notes'));
    } finally {
      setNotesSaving(false);
    }
  };

  /**
   * Get battery level indicator class based on percentage
   */
  const getBatteryClass = (level: number | undefined): string => {
    if (level === undefined || level === null) return '';
    if (level > 75) return 'battery-good';
    if (level > 25) return 'battery-medium';
    return 'battery-low';
  };

  /**
   * Get signal quality indicator class based on SNR
   */
  const getSignalClass = (snr: number | undefined): string => {
    if (snr === undefined || snr === null) return '';
    if (snr > 10) return 'signal-good';
    if (snr > 0) return 'signal-medium';
    return 'signal-low';
  };

  /**
   * Get utilization indicator class based on percentage
   */
  const getUtilizationClass = (utilization: number | undefined): string => {
    if (utilization === undefined || utilization === null) return '';
    if (utilization < 50) return 'utilization-good';
    if (utilization < 75) return 'utilization-medium';
    return 'utilization-high';
  };

  /**
   * Format battery level display
   */
  const formatBatteryLevel = (level: number | undefined): string => {
    if (level === undefined || level === null) return 'N/A';
    return `${level}%`;
  };

  /**
   * Format voltage display
   */
  const formatVoltage = (voltage: number | undefined): string => {
    if (voltage === undefined || voltage === null) return 'N/A';
    return `${voltage.toFixed(2)}V`;
  };

  /**
   * Format SNR display
   */
  const formatSNR = (snr: number | undefined): string => {
    if (snr === undefined || snr === null) return 'N/A';
    return `${snr.toFixed(1)} dB`;
  };

  /**
   * Format RSSI display
   */
  const formatRSSI = (rssi: number | undefined): string => {
    if (rssi === undefined || rssi === null) return 'N/A';
    return `${rssi} dBm`;
  };

  /**
   * Format utilization percentage
   */
  const formatUtilization = (utilization: number | undefined): string => {
    if (utilization === undefined || utilization === null) return 'N/A';
    return `${utilization.toFixed(1)}%`;
  };

  /**
   * Format uptime display
   */
  const formatUptime = (uptimeSeconds: number | undefined): string => {
    if (uptimeSeconds === undefined || uptimeSeconds === null) return 'N/A';
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);

    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else {
      return `${minutes}m`;
    }
  };

  /**
   * Format last heard timestamp
   */
  const formatLastHeard = (lastHeard: number | undefined): string => {
    if (lastHeard === undefined || lastHeard === null) return 'N/A';
    return formatRelativeTime(lastHeard * 1000, timeFormat, dateFormat, false);
  };

  /**
   * Format node ID in hex format
   */
  const formatNodeIdHex = (nodeNum: number | undefined): string => {
    if (nodeNum === undefined || nodeNum === null) return 'N/A';
    return `!${nodeNum.toString(16).toLowerCase().padStart(8, '0')}`;
  };

  /**
   * Format node ID in decimal format
   */
  const formatNodeIdDecimal = (nodeNum: number | undefined): string => {
    if (nodeNum === undefined || nodeNum === null) return 'N/A';
    return nodeNum.toString();
  };

  const { deviceMetrics, snr, rssi, lastHeard, hopsAway, viaMqtt, isStoreForwardServer, user, firmwareVersion } = node;
  const hwModel = user?.hwModel;
  const role = user?.role;
  const publicKey = user?.publicKey;
  const hardwareImageUrl = getHardwareImageUrl(hwModel);

  return (
    <div className="node-details-block">
      <div className="node-details-header">
        <h3 className="node-details-title">{t('node_details.title')}</h3>
        <button
          className="node-details-toggle"
          onClick={() => setIsCollapsed(!isCollapsed)}
          aria-label={isCollapsed ? t('node_details.expand') : t('node_details.collapse')}
        >
          {isCollapsed ? '▼' : '▲'}
        </button>
      </div>
      {!isCollapsed && (
        <div className="node-details-grid">
          {/* Hardware Model - Now First */}
          {hwModel !== undefined && (
            <div className="node-detail-card node-detail-card-hardware">
              <div className="node-detail-label">{t('node_details.hardware')}</div>
              <div className="node-detail-value node-detail-hardware-content">
                {hardwareImageUrl && (
                  <img
                    src={hardwareImageUrl}
                    alt={getHardwareModelName(hwModel) || 'Unknown'}
                    className="hardware-image"
                  />
                )}
                <span className="hardware-name">{getHardwareModelName(hwModel)}</span>
              </div>
            </div>
          )}

          {/* Battery Status */}
          {(deviceMetrics?.batteryLevel !== undefined || deviceMetrics?.voltage !== undefined) && (
            <div className="node-detail-card">
              <div className="node-detail-label">{t('node_details.battery')}</div>
              <div className={`node-detail-value ${getBatteryClass(deviceMetrics?.batteryLevel)}`}>
                {formatBatteryLevel(deviceMetrics?.batteryLevel)}
                {deviceMetrics?.voltage !== undefined && (
                  <span className="node-detail-secondary"> ({formatVoltage(deviceMetrics.voltage)})</span>
                )}
              </div>
            </div>
          )}

          {/* Signal Quality - SNR */}
          {snr !== undefined && (
            <div className="node-detail-card">
              <div className="node-detail-label">{t('node_details.signal_snr')}</div>
              <div className={`node-detail-value ${getSignalClass(snr)}`}>
                {formatSNR(snr)}
              </div>
            </div>
          )}

          {/* Signal Quality - RSSI */}
          {rssi !== undefined && (
            <div className="node-detail-card">
              <div className="node-detail-label">{t('node_details.signal_rssi')}</div>
              <div className="node-detail-value">
                {formatRSSI(rssi)}
              </div>
            </div>
          )}

          {/* Signal Trend (#4110) — derived link-attenuation badge. Rendered
              only when there is enough history to say something meaningful. */}
          {signalTrend && signalTrend.trend !== 'insufficient' && (
            <div className="node-detail-card">
              <div className="node-detail-label">{t('node_details.signal_trend', 'Signal Trend')}</div>
              <div
                className={`node-detail-value signal-trend signal-trend-${signalTrend.trend}`}
                title={buildSignalTrendTooltip(signalTrend, t)}
              >
                <span className="signal-trend-arrow" aria-hidden="true">{signalTrendArrow(signalTrend.trend)}</span>
                {' '}
                {t(`node_details.signal_trend_${signalTrend.trend}`,
                  signalTrend.trend === 'improving' ? 'Improving'
                    : signalTrend.trend === 'degrading' ? 'Degrading'
                    : 'Stable')}
              </div>
            </div>
          )}

          {/* Channel Utilization */}
          {deviceMetrics?.channelUtilization !== undefined && (
            <div className="node-detail-card">
              <div className="node-detail-label">{t('node_details.channel_utilization')}</div>
              <div className={`node-detail-value ${getUtilizationClass(deviceMetrics.channelUtilization)}`}>
                {formatUtilization(deviceMetrics.channelUtilization)}
              </div>
            </div>
          )}

          {/* Air Utilization TX */}
          {deviceMetrics?.airUtilTx !== undefined && (
            <div className="node-detail-card">
              <div className="node-detail-label">{t('node_details.air_utilization_tx')}</div>
              <div className={`node-detail-value ${getUtilizationClass(deviceMetrics.airUtilTx)}`}>
                {formatUtilization(deviceMetrics.airUtilTx)}
              </div>
            </div>
          )}

          {/* Noise Floor */}
          {deviceMetrics?.noiseFloor !== undefined && (
            <div className="node-detail-card">
              <div className="node-detail-label">{t('node_details.noise_floor')}</div>
              <div className="node-detail-value">
                {formatRSSI(deviceMetrics.noiseFloor)}
              </div>
            </div>
          )}

          {/* Uptime */}
          {deviceMetrics?.uptimeSeconds !== undefined && (
            <div className="node-detail-card">
              <div className="node-detail-label">{t('node_details.uptime')}</div>
              <div className="node-detail-value">
                {formatUptime(deviceMetrics.uptimeSeconds)}
              </div>
            </div>
          )}

        {/* Node ID */}
        {node.nodeNum !== undefined && (
          <div className="node-detail-card">
            <div className="node-detail-label">{t('node_details.node_id')}</div>
            <div className="node-detail-value">
              <div>{formatNodeIdHex(node.nodeNum)}</div>
              <div className="node-detail-secondary">{formatNodeIdDecimal(node.nodeNum)}</div>
            </div>
          </div>
        )}

        {/* Role */}
        {role !== undefined && (
          <div className="node-detail-card">
            <div className="node-detail-label">{t('node_details.role')}</div>
            <div className="node-detail-value">
              {getDeviceRoleName(role)}
            </div>
          </div>
        )}

        {/* Position (#4130) — lat/lon as plain text so a bad fix (e.g. 0,0) is
            visible without opening a map. */}
        {node.position?.latitude != null && node.position?.longitude != null && (
          <div className="node-detail-card">
            <div className="node-detail-label">{t('node_details.position', 'Position')}</div>
            <div className="node-detail-value">
              {node.position.latitude.toFixed(5)}, {node.position.longitude.toFixed(5)}
            </div>
          </div>
        )}

        {/* Elevation (#4130) */}
        {node.position?.altitude != null && (
          <div className="node-detail-card">
            <div className="node-detail-label">{t('node_details.elevation', 'Elevation')}</div>
            <div className="node-detail-value">
              {node.position.altitude}m
            </div>
          </div>
        )}

        {/* Channel */}
        {node.channel !== undefined && (
          <div className="node-detail-card">
            <div className="node-detail-label">{t('node_details.channel')}</div>
            <div className="node-detail-value">
              {(() => {
                const channel = (channels || []).find(ch => ch.id === node.channel);
                return channel?.name
                  ? `${node.channel} (${channel.name})`
                  : `${node.channel}`;
              })()}
            </div>
          </div>
        )}

        {/* Firmware Version */}
        {firmwareVersion && (
          <div className="node-detail-card">
            <div className="node-detail-label">{t('node_details.firmware')}</div>
            <div className="node-detail-value">
              {firmwareVersion}
            </div>
          </div>
        )}

        {/* Public Key */}
        {publicKey && (
          <div className="node-detail-card node-detail-card-2col">
            <div className="node-detail-label">{t('node_details.public_key')}</div>
            <div className="node-detail-value node-detail-public-key" title={publicKey}>
              {publicKey}
            </div>
          </div>
        )}

        {/* Hops Away */}
        {(hopsAway !== undefined || node.lastMessageHops !== undefined) && (() => {
          const effectiveHops = getEffectiveHops(node, nodeHopsCalculation, traceroutes, currentNodeNum);
          return effectiveHops < 999 ? (
            <div className="node-detail-card">
              <div className="node-detail-label">{t('node_details.hops_away')}</div>
              <div className="node-detail-value">
                {effectiveHops === 0 ? t('node_details.direct') : t('node_details.hops', { count: effectiveHops })}
              </div>
            </div>
          ) : null;
        })()}

        {/* Via MQTT */}
        {viaMqtt && (
          <div className="node-detail-card">
            <div className="node-detail-label">{t('node_details.connection')}</div>
            <div className="node-detail-value">
              {t('node_details.via_mqtt')}
            </div>
          </div>
        )}

        {/* Store & Forward Server */}
        {isStoreForwardServer && (
          <div className="node-detail-card">
            <div className="node-detail-label">{t('node_details.store_forward', 'Store & Forward')}</div>
            <div className="node-detail-value">
              {t('node_details.store_forward_server', 'S&F Server')}
            </div>
          </div>
        )}

        {/* Remote Admin Status */}
        {(() => {
          // Determine remote admin state: unknown (never tested), available, or unavailable
          const hasBeenTested = node.lastRemoteAdminCheck !== undefined && node.lastRemoteAdminCheck !== null;
          const checkDate = hasBeenTested ? formatRelativeTime(node.lastRemoteAdminCheck!, timeFormat, dateFormat, false) : null;

          if (!hasBeenTested) {
            // Never been tested
            return (
              <div className="node-detail-card">
                <div className="node-detail-label">{t('node_details.remote_admin')}</div>
                <div className="node-detail-value">
                  {t('node_details.remote_admin_unknown')}
                </div>
              </div>
            );
          } else if (node.hasRemoteAdmin) {
            // Available
            return (
              <div className="node-detail-card">
                <div className="node-detail-label">{t('node_details.remote_admin')}</div>
                <div className="node-detail-value signal-good">
                  {t('node_details.remote_admin_yes')}
                  <span className="node-detail-secondary"> ({checkDate})</span>
                </div>
              </div>
            );
          } else {
            // Unavailable (tested but failed)
            return (
              <div className="node-detail-card">
                <div className="node-detail-label">{t('node_details.remote_admin')}</div>
                <div className="node-detail-value">
                  {t('node_details.remote_admin_no')}
                  <span className="node-detail-secondary"> ({checkDate})</span>
                </div>
              </div>
            );
          }
        })()}

        {/* Remote Admin Metadata */}
        {node.hasRemoteAdmin && node.remoteAdminMetadata && (() => {
          try {
            const metadata = JSON.parse(node.remoteAdminMetadata);
            return (
              <>
                {metadata.firmwareVersion && (
                  <div className="node-detail-card">
                    <div className="node-detail-label">{t('node_details.remote_firmware')}</div>
                    <div className="node-detail-value">{metadata.firmwareVersion}</div>
                  </div>
                )}
                {metadata.hasWifi !== undefined && (
                  <div className="node-detail-card">
                    <div className="node-detail-label">{t('node_details.has_wifi')}</div>
                    <div className="node-detail-value">
                      {metadata.hasWifi ? t('common.yes') : t('common.no')}
                    </div>
                  </div>
                )}
                {metadata.hasBluetooth !== undefined && (
                  <div className="node-detail-card">
                    <div className="node-detail-label">{t('node_details.has_bluetooth')}</div>
                    <div className="node-detail-value">
                      {metadata.hasBluetooth ? t('common.yes') : t('common.no')}
                    </div>
                  </div>
                )}
                {metadata.hasEthernet !== undefined && (
                  <div className="node-detail-card">
                    <div className="node-detail-label">{t('node_details.has_ethernet')}</div>
                    <div className="node-detail-value">
                      {metadata.hasEthernet ? t('common.yes') : t('common.no')}
                    </div>
                  </div>
                )}
                {metadata.canShutdown !== undefined && (
                  <div className="node-detail-card">
                    <div className="node-detail-label">{t('node_details.can_shutdown')}</div>
                    <div className="node-detail-value">
                      {metadata.canShutdown ? t('common.yes') : t('common.no')}
                    </div>
                  </div>
                )}
              </>
            );
          } catch {
            return null;
          }
        })()}

          {/* Last Heard */}
          {lastHeard !== undefined && (
            <div className="node-detail-card">
              <div className="node-detail-label">{t('node_details.last_heard')}</div>
              <div className="node-detail-value">
                {formatLastHeard(lastHeard)}
              </div>
            </div>
          )}

          {/* Notes (#3921) — editable when permitted, otherwise read-only */}
          {(canEditNotes && onSaveNotes) ? (
            <div className="node-detail-card node-detail-card-2col node-detail-notes">
              <div className="node-detail-label">{t('node_details.notes', 'Notes')}</div>
              <textarea
                className="node-detail-notes-input"
                value={notesDraft}
                maxLength={MAX_NODE_NOTES_LENGTH}
                rows={3}
                placeholder={t('node_details.notes_placeholder', 'Add a private note about this node…')}
                onChange={e => setNotesDraft(e.target.value)}
                disabled={notesSaving}
              />
              {notesError && <span className="node-detail-notes-error">{notesError}</span>}
              <div className="node-detail-notes-actions">
                <button
                  type="button"
                  className="node-detail-notes-save"
                  onClick={handleSaveNotes}
                  disabled={notesSaving || !notesDirty}
                >
                  {notesSaving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
                </button>
              </div>
            </div>
          ) : storedNotes ? (
            <div className="node-detail-card node-detail-card-2col node-detail-notes">
              <div className="node-detail-label">{t('node_details.notes', 'Notes')}</div>
              <div className="node-detail-value node-detail-notes-readonly">{storedNotes}</div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};

export default NodeDetailsBlock;
