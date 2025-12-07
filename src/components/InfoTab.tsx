import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { DeviceInfo, Channel } from '../types/device';
import { MeshMessage } from '../types/message';
import { ConnectionStatus } from '../types/ui';
import { TemperatureUnit } from '../utils/temperature';
import { TimeFormat, DateFormat } from '../contexts/SettingsContext';
import { formatDateTime } from '../utils/datetime';
import TelemetryGraphs from './TelemetryGraphs';
import { version } from '../../package.json';
import apiService from '../services/api';
import { formatDistance } from '../utils/distance';
import { logger } from '../utils/logger';
import { useToast } from './ToastContainer';
import { getDeviceRoleName } from '../utils/deviceRole';

interface RouteSegment {
  id: number;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  fromNodeName: string;
  toNodeName: string;
  distanceKm: number;
  timestamp: number;
}

interface InfoTabProps {
  connectionStatus: ConnectionStatus;
  nodeAddress: string;
  deviceInfo: any;
  deviceConfig: any;
  nodes: DeviceInfo[];
  channels: Channel[];
  messages: MeshMessage[];
  currentNodeId: string;
  temperatureUnit: TemperatureUnit;
  telemetryHours: number;
  baseUrl: string;
  getAvailableChannels: () => number[];
  distanceUnit?: 'km' | 'mi';
  timeFormat?: TimeFormat;
  dateFormat?: DateFormat;
  isAuthenticated?: boolean;
}

const InfoTab: React.FC<InfoTabProps> = React.memo(({
  connectionStatus,
  nodeAddress,
  deviceInfo,
  deviceConfig,
  nodes,
  channels,
  messages,
  currentNodeId,
  temperatureUnit,
  telemetryHours,
  baseUrl,
  getAvailableChannels,
  distanceUnit = 'km',
  timeFormat = '24',
  dateFormat = 'MM/DD/YYYY',
  isAuthenticated = false
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [longestActiveSegment, setLongestActiveSegment] = useState<RouteSegment | null>(null);
  const [recordHolderSegment, setRecordHolderSegment] = useState<RouteSegment | null>(null);
  const [loadingSegments, setLoadingSegments] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [virtualNodeStatus, setVirtualNodeStatus] = useState<any>(null);
  const [loadingVirtualNode, setLoadingVirtualNode] = useState(false);
  const [serverInfo, setServerInfo] = useState<any>(null);
  const [loadingServerInfo, setLoadingServerInfo] = useState(false);
  const [localStats, setLocalStats] = useState<any>(null);

  const fetchVirtualNodeStatus = async () => {
    if (connectionStatus !== 'connected') return;

    setLoadingVirtualNode(true);
    try {
      const status = await apiService.getVirtualNodeStatus();
      setVirtualNodeStatus(status);
    } catch (error) {
      logger.error('Error fetching virtual node status:', error);
    } finally {
      setLoadingVirtualNode(false);
    }
  };

  const fetchServerInfo = async () => {
    if (connectionStatus !== 'connected') return;

    setLoadingServerInfo(true);
    try {
      const info = await apiService.getServerInfo();
      setServerInfo(info);
    } catch (error) {
      logger.error('Error fetching server info:', error);
    } finally {
      setLoadingServerInfo(false);
    }
  };

  const fetchLocalStats = async () => {
    if (connectionStatus !== 'connected' || !currentNodeId) return;

    try {
      const response = await fetch(`${baseUrl}/api/telemetry/${currentNodeId}?hours=1`);
      if (!response.ok) throw new Error('Failed to fetch local stats');
      const data = await response.json();

      // Extract the latest value for each LocalStats and HostMetrics metric
      const stats: any = {};
      const metrics = [
        // LocalStats metrics
        'uptimeSeconds', 'channelUtilization', 'airUtilTx',
        'numPacketsTx', 'numPacketsRx', 'numPacketsRxBad',
        'numOnlineNodes', 'numTotalNodes', 'numRxDupe',
        'numTxRelay', 'numTxRelayCanceled', 'heapTotalBytes',
        'heapFreeBytes', 'numTxDropped',
        // HostMetrics metrics (for Linux devices)
        'hostUptimeSeconds', 'hostFreememBytes', 'hostDiskfree1Bytes',
        'hostDiskfree2Bytes', 'hostDiskfree3Bytes', 'hostLoad1',
        'hostLoad5', 'hostLoad15'
      ];

      metrics.forEach(metric => {
        const entries = data.filter((item: any) => item.telemetryType === metric);
        if (entries.length > 0) {
          // Get the most recent value
          const latest = entries.reduce((prev: any, current: any) =>
            current.timestamp > prev.timestamp ? current : prev
          );
          stats[metric] = latest.value;
        }
      });

      setLocalStats(stats);
    } catch (error) {
      logger.error('Error fetching local stats:', error);
    }
  };

  const fetchRouteSegments = async () => {
    if (connectionStatus !== 'connected') return;

    setLoadingSegments(true);
    try {
      const [longest, recordHolder] = await Promise.all([
        apiService.getLongestActiveRouteSegment(),
        apiService.getRecordHolderRouteSegment()
      ]);
      setLongestActiveSegment(longest);
      setRecordHolderSegment(recordHolder);
    } catch (error) {
      logger.error('Error fetching route segments:', error);
    } finally {
      setLoadingSegments(false);
    }
  };

  const handleClearRecordHolder = async () => {
    setShowConfirmDialog(true);
  };

  const confirmClearRecordHolder = async () => {
    setShowConfirmDialog(false);
    try {
      await apiService.clearRecordHolderSegment();
      setRecordHolderSegment(null);
      showToast(t('info.record_cleared'), 'success');
    } catch (error) {
      logger.error('Error clearing record holder:', error);
      if (error instanceof Error && error.message.includes('403')) {
        showToast(t('info.record_clear_permission'), 'error');
      } else {
        showToast(t('info.record_clear_failed'), 'error');
      }
    }
  };

  useEffect(() => {
    fetchRouteSegments();
    const interval = setInterval(fetchRouteSegments, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, [connectionStatus]);

  useEffect(() => {
    fetchVirtualNodeStatus();
    const interval = setInterval(fetchVirtualNodeStatus, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, [connectionStatus]);

  useEffect(() => {
    fetchServerInfo();
    const interval = setInterval(fetchServerInfo, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, [connectionStatus]);

  useEffect(() => {
    fetchLocalStats();
    const interval = setInterval(fetchLocalStats, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, [connectionStatus, currentNodeId]);

  // Helper function to format uptime
  const formatUptime = (uptimeSeconds: number): string => {
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = Math.floor(uptimeSeconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

    return parts.join(' ');
  };

  // Stable callbacks
  const handleClearRecordClick = useCallback(() => {
    handleClearRecordHolder();
  }, [handleClearRecordHolder]);

  const handleCancelConfirm = useCallback(() => {
    setShowConfirmDialog(false);
  }, []);

  const handleConfirmClear = useCallback(() => {
    confirmClearRecordHolder();
  }, [confirmClearRecordHolder]);

  return (
    <div className="tab-content">
      <h2>{t('info.title')}</h2>
      <div className="device-info">
        <div className="info-section">
          <h3>{t('info.connection_status')}</h3>
          {isAuthenticated && (
            <p><strong>{t('info.node_address')}</strong> {nodeAddress}</p>
          )}
          {deviceConfig?.basic?.nodeId && (
            <p><strong>{t('info.node_id')}</strong> {deviceConfig.basic.nodeId}</p>
          )}
          {deviceConfig?.basic?.nodeName && (
            <p><strong>{t('info.node_name')}</strong> {deviceConfig.basic.nodeName}</p>
          )}
          {deviceConfig?.basic && (
            <p><strong>{t('info.firmware_version')}</strong> {deviceConfig.basic.firmwareVersion || t('info.not_available')}</p>
          )}
          <p><strong>{t('info.connection_status_label')}</strong> <span className={`status-text ${connectionStatus}`}>{connectionStatus}</span></p>
          {(localStats?.uptimeSeconds !== undefined || localStats?.hostUptimeSeconds !== undefined) && (
            <p><strong>{t('info.uptime')}</strong> {formatUptime(localStats.hostUptimeSeconds ?? localStats.uptimeSeconds)}</p>
          )}
          <p><strong>{t('info.uses_tls')}</strong> {deviceInfo?.meshtasticUseTls ? t('common.yes') : t('common.no')}</p>
          {deviceInfo?.deviceMetadata?.rebootCount !== undefined && (
            <p><strong>{t('info.reboot_count')}</strong> {deviceInfo.deviceMetadata.rebootCount}</p>
          )}
        </div>

        {deviceConfig && (
          <>
            <div className="info-section">
              <h3>{t('info.lora_config')}</h3>
              {(() => {
                const localNode = nodes.find(n => n.user?.id === currentNodeId);
                const roleName = getDeviceRoleName(localNode?.user?.role);
                return <p><strong>{t('info.device_role')}</strong> {roleName}</p>;
              })()}
              <p><strong>{t('info.region')}</strong> {deviceConfig.radio?.region || t('info.unknown')}</p>
              <p><strong>{t('info.modem_preset')}</strong> {deviceConfig.radio?.modemPreset || t('info.unknown')}</p>
              <p><strong>{t('info.channel_number')}</strong> {deviceConfig.radio?.channelNum !== undefined ? deviceConfig.radio.channelNum : t('info.unknown')}</p>
              <p><strong>{t('info.frequency')}</strong> {deviceConfig.radio?.frequency || t('info.unknown')}</p>
              <p><strong>{t('info.hop_limit')}</strong> {deviceConfig.radio?.hopLimit !== undefined ? deviceConfig.radio.hopLimit : t('info.unknown')}</p>
              <p><strong>{t('info.tx_power')}</strong> {deviceConfig.radio?.txPower !== undefined ? `${deviceConfig.radio.txPower} dBm` : t('info.unknown')}</p>
              <p><strong>{t('info.tx_enabled')}</strong> {deviceConfig.radio?.txEnabled !== undefined ? (deviceConfig.radio.txEnabled ? t('common.yes') : t('common.no')) : t('info.unknown')}</p>
              <p><strong>{t('info.boosted_rx_gain')}</strong> {deviceConfig.radio?.sx126xRxBoostedGain !== undefined ? (deviceConfig.radio.sx126xRxBoostedGain ? t('common.yes') : t('common.no')) : t('info.unknown')}</p>
            </div>

            {isAuthenticated && (
              <div className="info-section">
                <h3>{t('info.mqtt_config')}</h3>
                <p><strong>{t('info.mqtt_enabled')}</strong> {deviceConfig.mqtt?.enabled ? t('common.yes') : t('common.no')}</p>
                <p><strong>{t('info.mqtt_server')}</strong> {deviceConfig.mqtt?.server || t('info.not_configured')}</p>
                <p><strong>{t('info.mqtt_username')}</strong> {deviceConfig.mqtt?.username || t('info.not_set')}</p>
                <p><strong>{t('info.mqtt_encryption')}</strong> {deviceConfig.mqtt?.encryption ? t('common.yes') : t('common.no')}</p>
                <p><strong>{t('info.mqtt_json')}</strong> {deviceConfig.mqtt?.json ? t('common.enabled') : t('common.disabled')}</p>
                <p><strong>{t('info.mqtt_tls')}</strong> {deviceConfig.mqtt?.tls ? t('common.yes') : t('common.no')}</p>
                <p><strong>{t('info.mqtt_root_topic')}</strong> {deviceConfig.mqtt?.rootTopic || 'msh'}</p>
              </div>
            )}
          </>
        )}

        <div className="info-section">
          <h3>{t('info.app_info')}</h3>
          <p><strong>{t('info.version')}</strong> {version}</p>
          {loadingServerInfo && <p>{t('common.loading_indicator')}</p>}
          {!loadingServerInfo && serverInfo && (
            <p>
              <strong>{t('info.timezone')}</strong> {serverInfo.timezone}
              {!serverInfo.timezoneProvided && (
                <span style={{ fontSize: '0.85em', color: '#888', marginLeft: '0.5rem' }}>
                  {t('info.timezone_default')}
                </span>
              )}
            </p>
          )}
        </div>

        <div className="info-section">
          <h3>{t('info.virtual_node')}</h3>
          {loadingVirtualNode && <p>{t('common.loading_indicator')}</p>}
          {!loadingVirtualNode && virtualNodeStatus && (
            <>
              <p><strong>{t('info.virtual_node_status')}</strong> {virtualNodeStatus.enabled ? t('common.enabled') : t('common.disabled')}</p>
              {virtualNodeStatus.enabled && (
                <>
                  <p><strong>{t('info.server_running')}</strong> {virtualNodeStatus.isRunning ? t('common.yes') : t('common.no')}</p>
                  <p><strong>{t('info.connected_clients')}</strong> {virtualNodeStatus.clientCount}</p>

                  {virtualNodeStatus.clients && virtualNodeStatus.clients.length > 0 && (
                    <div style={{ marginTop: '0.75rem', fontSize: '0.9em' }}>
                      <strong>{t('info.client_details')}</strong>
                      {virtualNodeStatus.clients.map((client: any) => (
                        <div key={client.id} style={{
                          marginTop: '0.5rem',
                          padding: '0.5rem',
                          backgroundColor: 'var(--ctp-surface0)',
                          borderRadius: '4px'
                        }}>
                          <p style={{ margin: '0.25rem 0' }}><strong>{t('info.client_id')}</strong> {client.id}</p>
                          <p style={{ margin: '0.25rem 0' }}><strong>{t('info.client_ip')}</strong> {client.ip}</p>
                          <p style={{ margin: '0.25rem 0' }}><strong>{t('info.client_connected')}</strong> {formatDateTime(new Date(client.connectedAt), timeFormat, dateFormat)}</p>
                          <p style={{ margin: '0.25rem 0' }}><strong>{t('info.client_last_activity')}</strong> {formatDateTime(new Date(client.lastActivity), timeFormat, dateFormat)}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              <p style={{ fontSize: '0.9em', color: '#888', marginTop: '0.75rem' }}>
                {t('info.virtual_node_description')}
              </p>
              <p style={{ fontSize: '0.85em', color: '#999', marginTop: '0.5rem', fontStyle: 'italic' }}>
                {t('info.virtual_node_note')}
              </p>
            </>
          )}
          {!loadingVirtualNode && !virtualNodeStatus && (
            <p className="no-data">{t('info.virtual_node_unavailable')}</p>
          )}
        </div>

        <div className="info-section">
          <h3>{t('info.network_stats')}</h3>
          <p><strong>{t('info.total_nodes')}</strong> {nodes.length}</p>
          <p><strong>{t('info.total_channels')}</strong> {channels.length}</p>
          <p><strong>{t('info.total_messages')}</strong> {messages.length}</p>
          <p><strong>{t('info.active_channels')}</strong> {getAvailableChannels().length}</p>
          {localStats?.numPacketsTx !== undefined ? (
            <>
              <p><strong>{t('info.packets_tx')}</strong> {localStats.numPacketsTx.toLocaleString()}</p>
              <p><strong>{t('info.packets_rx')}</strong> {localStats.numPacketsRx?.toLocaleString() || t('info.na')}</p>
              <p><strong>{t('info.rx_bad')}</strong> {localStats.numPacketsRxBad?.toLocaleString() || '0'}</p>
              <p><strong>{t('info.rx_duplicate')}</strong> {localStats.numRxDupe?.toLocaleString() || '0'}</p>
              <p><strong>{t('info.tx_dropped')}</strong> {localStats.numTxDropped?.toLocaleString() || '0'}</p>
            </>
          ) : localStats?.hostUptimeSeconds !== undefined ? (
            <p style={{ fontSize: '0.9em', color: '#888', marginTop: '0.5rem' }}>
              {t('info.packet_stats_unavailable')}
            </p>
          ) : null}
        </div>

        {localStats?.hostUptimeSeconds !== undefined && (
          <div className="info-section">
            <h3>{t('info.host_metrics')}</h3>
            <p style={{ fontSize: '0.9em', color: '#888', fontStyle: 'italic', marginBottom: '0.5rem' }}>
              {t('info.host_metrics_description')}
            </p>
            {localStats.hostUptimeSeconds !== undefined && (
              <p><strong>{t('info.host_uptime')}</strong> {formatUptime(localStats.hostUptimeSeconds)}</p>
            )}
            {localStats.hostFreememBytes !== undefined && (
              <p><strong>{t('info.free_memory')}</strong> {(localStats.hostFreememBytes / 1024 / 1024).toFixed(0)} MB</p>
            )}
            {localStats.hostDiskfree1Bytes !== undefined && (
              <p><strong>{t('info.disk_free_root')}</strong> {(localStats.hostDiskfree1Bytes / 1024 / 1024 / 1024).toFixed(2)} GB</p>
            )}
            {localStats.hostDiskfree2Bytes !== undefined && (
              <p><strong>{t('info.disk_free_2')}</strong> {(localStats.hostDiskfree2Bytes / 1024 / 1024 / 1024).toFixed(2)} GB</p>
            )}
            {localStats.hostDiskfree3Bytes !== undefined && (
              <p><strong>{t('info.disk_free_3')}</strong> {(localStats.hostDiskfree3Bytes / 1024 / 1024 / 1024).toFixed(2)} GB</p>
            )}
            {localStats.hostLoad1 !== undefined && (
              <p><strong>{t('info.load_average')}</strong> {(localStats.hostLoad1 / 100).toFixed(2)} / {(localStats.hostLoad5 / 100).toFixed(2)} / {(localStats.hostLoad15 / 100).toFixed(2)}</p>
            )}
          </div>
        )}

        <div className="info-section">
          <h3>{t('info.recent_activity')}</h3>
          <p><strong>{t('info.last_message')}</strong> {messages.length > 0 ? formatDateTime(messages[0].timestamp, timeFormat, dateFormat) : t('common.none')}</p>
          <p><strong>{t('info.most_active_node')}</strong> {
            nodes.length > 0 ?
            nodes.reduce((prev, current) =>
              (prev.lastHeard || 0) > (current.lastHeard || 0) ? prev : current
            ).user?.longName || t('info.unknown') : t('common.none')
          }</p>
        </div>

        <div className="info-section">
          <h3>{t('info.longest_route')}</h3>
          {loadingSegments && <p>{t('common.loading_indicator')}</p>}
          {!loadingSegments && longestActiveSegment && (
            <>
              <p><strong>{t('info.distance')}</strong> {formatDistance(longestActiveSegment.distanceKm, distanceUnit)}</p>
              <p><strong>{t('info.from')}</strong> {longestActiveSegment.fromNodeName} ({longestActiveSegment.fromNodeId})</p>
              <p><strong>{t('info.to')}</strong> {longestActiveSegment.toNodeName} ({longestActiveSegment.toNodeId})</p>
              <p style={{ fontSize: '0.85em', color: '#888' }}>
                {t('info.last_seen')} {formatDateTime(new Date(longestActiveSegment.timestamp), timeFormat, dateFormat)}
              </p>
            </>
          )}
          {!loadingSegments && !longestActiveSegment && (
            <p className="no-data">{t('info.no_active_routes')}</p>
          )}
        </div>

        <div className="info-section">
          <h3>{t('info.record_holder')}</h3>
          {loadingSegments && <p>{t('common.loading_indicator')}</p>}
          {!loadingSegments && recordHolderSegment && (
            <>
              <p><strong>{t('info.distance')}</strong> {formatDistance(recordHolderSegment.distanceKm, distanceUnit)} 🏆</p>
              <p><strong>{t('info.from')}</strong> {recordHolderSegment.fromNodeName} ({recordHolderSegment.fromNodeId})</p>
              <p><strong>{t('info.to')}</strong> {recordHolderSegment.toNodeName} ({recordHolderSegment.toNodeId})</p>
              <p style={{ fontSize: '0.85em', color: '#888' }}>
                {t('info.achieved')} {formatDateTime(new Date(recordHolderSegment.timestamp), timeFormat, dateFormat)}
              </p>
              {isAuthenticated && (
                <button
                  onClick={handleClearRecordClick}
                  className="danger-button"
                  style={{ marginTop: '8px' }}
                >
                  {t('info.clear_record')}
                </button>
              )}
            </>
          )}
          {!loadingSegments && !recordHolderSegment && (
            <p className="no-data">{t('info.no_record_holder')}</p>
          )}
        </div>

        {!deviceConfig && (
          <div className="info-section">
            <p className="no-data">{t('info.device_config_unavailable')}</p>
          </div>
        )}
      </div>

      {currentNodeId && connectionStatus === 'connected' && (
        <div className="info-section-full-width">
          <h3>{t('info.local_telemetry')}</h3>
          <TelemetryGraphs nodeId={currentNodeId} temperatureUnit={temperatureUnit} telemetryHours={telemetryHours} baseUrl={baseUrl} />
        </div>
      )}

      {showConfirmDialog && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            backgroundColor: 'var(--ctp-base)',
            padding: '2rem',
            borderRadius: '8px',
            maxWidth: '400px',
            border: '1px solid var(--ctp-surface2)'
          }}>
            <h3 style={{ marginTop: 0 }}>{t('info.clear_record_title')}</h3>
            <p>{t('info.clear_record_confirm')}</p>
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
              <button
                onClick={handleCancelConfirm}
                className="btn-secondary"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleConfirmClear}
                className="danger-button"
              >
                {t('info.clear_record')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

InfoTab.displayName = 'InfoTab';

export default InfoTab;