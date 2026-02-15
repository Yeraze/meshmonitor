import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { DeviceInfo, Channel } from '../types/device';
import { MeshMessage } from '../types/message';
import { ConnectionStatus } from '../types/ui';
import { TemperatureUnit } from '../utils/temperature';
import { TimeFormat, DateFormat } from '../contexts/SettingsContext';
import { formatDateTime } from '../utils/datetime';
import TelemetryGraphs from './TelemetryGraphs';
import PacketRateGraphs from './PacketRateGraphs';
import { version } from '../../package.json';
import apiService from '../services/api';
import { formatDistance } from '../utils/distance';
import { logger } from '../utils/logger';
import { useToast } from './ToastContainer';
import { getDeviceRoleName } from '../utils/deviceRole';
import { getPacketDistributionStats } from '../services/packetApi';
import { PacketDistributionStats } from '../types/packet';
import PacketStatsChart, { ChartDataEntry, DISTRIBUTION_COLORS } from './PacketStatsChart';

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
  channelMessages?: { [key: number]: MeshMessage[] };
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
  channelMessages = {},
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
  const [securityKeys, setSecurityKeys] = useState<{ publicKey: string | null; privateKey: string | null } | null>(null);
  const [loadingSecurityKeys, setLoadingSecurityKeys] = useState(false);
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [packetDistribution, setPacketDistribution] = useState<PacketDistributionStats | null>(null);
  const [distributionTimeRange, setDistributionTimeRange] = useState<'hour' | '24h' | 'all'>('24h');
  const [loadingDistribution, setLoadingDistribution] = useState(false);
  const [selectedPortnum, setSelectedPortnum] = useState<number | null>(4); // Default to NODEINFO_APP
  const [portnumNodeDistribution, setPortnumNodeDistribution] = useState<PacketDistributionStats | null>(null);
  const [loadingPortnumNodes, setLoadingPortnumNodes] = useState(false);

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

  const fetchSecurityKeys = async () => {
    if (connectionStatus !== 'connected' || !isAuthenticated) return;

    setLoadingSecurityKeys(true);
    try {
      const keys = await apiService.getSecurityKeys();
      setSecurityKeys(keys);
    } catch (error) {
      logger.error('Error fetching security keys:', error);
    } finally {
      setLoadingSecurityKeys(false);
    }
  };

  const fetchPacketDistribution = useCallback(async () => {
    if (connectionStatus !== 'connected') return;

    setLoadingDistribution(true);
    try {
      // Calculate 'since' timestamp based on time range
      let since: number | undefined;
      const now = Math.floor(Date.now() / 1000);
      if (distributionTimeRange === 'hour') {
        since = now - 3600; // 1 hour ago
      } else if (distributionTimeRange === '24h') {
        since = now - 86400; // 24 hours ago
      }
      // 'all' = undefined (no since filter)

      const distribution = await getPacketDistributionStats(since);
      setPacketDistribution(distribution);
    } catch (error) {
      logger.error('Error fetching packet distribution:', error);
    } finally {
      setLoadingDistribution(false);
    }
  }, [connectionStatus, distributionTimeRange]);

  const fetchPortnumNodeDistribution = useCallback(async () => {
    if (connectionStatus !== 'connected' || selectedPortnum === null) return;

    setLoadingPortnumNodes(true);
    try {
      let since: number | undefined;
      const now = Math.floor(Date.now() / 1000);
      if (distributionTimeRange === 'hour') {
        since = now - 3600;
      } else if (distributionTimeRange === '24h') {
        since = now - 86400;
      }

      const distribution = await getPacketDistributionStats(since, undefined, selectedPortnum);
      setPortnumNodeDistribution(distribution);
    } catch (error) {
      logger.error('Error fetching portnum node distribution:', error);
    } finally {
      setLoadingPortnumNodes(false);
    }
  }, [connectionStatus, selectedPortnum, distributionTimeRange]);

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

  useEffect(() => {
    fetchSecurityKeys();
    // Only fetch once when connected and authenticated - keys don't change frequently
  }, [connectionStatus, isAuthenticated]);

  useEffect(() => {
    fetchPacketDistribution();
    const interval = setInterval(fetchPacketDistribution, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, [fetchPacketDistribution]);

  useEffect(() => {
    if (selectedPortnum !== null) {
      fetchPortnumNodeDistribution();
      const interval = setInterval(fetchPortnumNodeDistribution, 60000);
      return () => clearInterval(interval);
    }
  }, [fetchPortnumNodeDistribution, selectedPortnum]);

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

            {isAuthenticated && (
              <div className="info-section">
                <h3>{t('info.secrets')}</h3>
                {loadingSecurityKeys && <p>{t('common.loading_indicator')}</p>}
                {!loadingSecurityKeys && securityKeys && (
                  <>
                    <div style={{ marginBottom: '0.75rem' }}>
                      <p><strong>{t('info.public_key')}</strong></p>
                      <input
                        type="text"
                        readOnly
                        value={securityKeys.publicKey || t('info.not_available')}
                        style={{
                          width: '100%',
                          padding: '0.5rem',
                          fontSize: '0.85rem',
                          fontFamily: 'monospace',
                          backgroundColor: 'var(--ctp-surface0)',
                          border: '1px solid var(--ctp-surface2)',
                          borderRadius: '4px',
                          color: 'var(--ctp-text)'
                        }}
                      />
                    </div>
                    <div>
                      <p><strong>{t('info.private_key')}</strong></p>
                      <div style={{ position: 'relative' }}>
                        <input
                          type={showPrivateKey ? 'text' : 'password'}
                          readOnly
                          value={securityKeys.privateKey || t('info.not_available')}
                          style={{
                            width: '100%',
                            padding: '0.5rem',
                            paddingRight: '2.5rem',
                            fontSize: '0.85rem',
                            fontFamily: 'monospace',
                            backgroundColor: 'var(--ctp-surface0)',
                            border: '1px solid var(--ctp-surface2)',
                            borderRadius: '4px',
                            color: 'var(--ctp-text)'
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPrivateKey(!showPrivateKey)}
                          title={showPrivateKey ? t('info.hide_private_key', 'Hide') : t('info.show_private_key', 'Show')}
                          style={{
                            position: 'absolute',
                            right: '0.5rem',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: '0.25rem',
                            fontSize: '1rem',
                            color: 'var(--ctp-subtext0)',
                            lineHeight: 1
                          }}
                        >
                          {showPrivateKey ? '\u{1F648}' : '\u{1F441}\uFE0F'}
                        </button>
                      </div>
                    </div>
                  </>
                )}
                {!loadingSecurityKeys && !securityKeys && (
                  <p className="no-data">{t('info.secrets_unavailable')}</p>
                )}
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
          {localStats?.numPacketsTx !== undefined && (
            <>
              <p><strong>{t('info.packets_tx')}</strong> {localStats.numPacketsTx.toLocaleString()}</p>
              <p><strong>{t('info.packets_rx')}</strong> {localStats.numPacketsRx?.toLocaleString() || t('info.na')}</p>
            </>
          )}
          {localStats?.hostUptimeSeconds !== undefined && localStats?.numPacketsTx === undefined && (
            <p style={{ fontSize: '0.9em', color: '#888', marginTop: '0.5rem' }}>
              {t('info.packet_stats_unavailable')}
            </p>
          )}
        </div>

        {(localStats?.numPacketsRx > 0 || localStats?.numPacketsTx > 0) && (() => {
          const rxTotal = localStats.numPacketsRx || 0;
          const rxBad = localStats.numPacketsRxBad || 0;
          const rxDupe = localStats.numRxDupe || 0;
          const rxGood = Math.max(0, rxTotal - rxBad - rxDupe);
          const rxData: ChartDataEntry[] = [
            { name: t('info.rx_good'), value: rxGood, color: '#a6e3a1' },
            { name: t('info.rx_bad_short'), value: rxBad, color: '#f38ba8' },
            { name: t('info.rx_dupe_short'), value: rxDupe, color: '#fab387' },
          ];

          const txTotal = localStats.numPacketsTx || 0;
          const txDropped = localStats.numTxDropped || 0;
          const txRelay = localStats.numTxRelay || 0;
          // Note: numTxRelayCanceled is NOT part of numPacketsTx - it counts packets
          // that were never transmitted because another node relayed first
          const txDirect = Math.max(0, txTotal - txDropped - txRelay);
          const txData: ChartDataEntry[] = [
            { name: t('info.tx_direct'), value: txDirect, color: '#89b4fa' },
            { name: t('info.tx_relay_short'), value: txRelay, color: '#a6e3a1' },
            { name: t('info.tx_dropped_short'), value: txDropped, color: '#f38ba8' },
          ];

          return (
            <div className="info-section">
              <h3>{t('info.radio_statistics', 'Radio Statistics')}</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {rxTotal > 0 && (
                  <PacketStatsChart
                    title={t('info.rx_statistics')}
                    data={rxData}
                    total={rxTotal}
                    chartId="rx"
                    bare
                  />
                )}
                {txTotal > 0 && (
                  <PacketStatsChart
                    title={t('info.tx_statistics')}
                    data={txData}
                    total={txTotal}
                    chartId="tx"
                    bare
                  />
                )}
              </div>
            </div>
          );
        })()}

        {/* Packet Distribution Charts - only shown when packet monitor is enabled */}
        {packetDistribution?.enabled && (() => {
          // Prepare device data with "Other" grouping
          const deviceData: ChartDataEntry[] = packetDistribution.byDevice.map((d, i) => ({
            name: d.from_node_longName || d.from_node_id || `Node ${d.from_node}`,
            value: d.count,
            color: DISTRIBUTION_COLORS[i % DISTRIBUTION_COLORS.length]
          }));

          // Calculate "Other" if there are more devices beyond top 10
          const deviceTotal = deviceData.reduce((sum, d) => sum + d.value, 0);
          const otherCount = packetDistribution.total - deviceTotal;
          if (otherCount > 0) {
            deviceData.push({
              name: t('info.other_devices'),
              value: otherCount,
              color: DISTRIBUTION_COLORS[10] // Use the gray color for "Other"
            });
          }

          // Prepare type data
          const typeData: ChartDataEntry[] = packetDistribution.byType.map((p, i) => ({
            name: p.portnum_name.replace(/_APP$/, '').replace(/_/g, ' '),
            value: p.count,
            color: DISTRIBUTION_COLORS[i % DISTRIBUTION_COLORS.length]
          }));

          const timeRangeButtonStyle = (active: boolean): React.CSSProperties => ({
            padding: '0.25rem 0.75rem',
            fontSize: '0.85em',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: active ? 600 : 400,
            background: active ? 'var(--ctp-blue)' : 'var(--ctp-surface1)',
            color: active ? 'var(--ctp-crust)' : 'var(--ctp-subtext0)',
          });

          const timeRangeButtons = (
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => setDistributionTimeRange('hour')}
                style={timeRangeButtonStyle(distributionTimeRange === 'hour')}
              >
                {t('info.last_hour')}
              </button>
              <button
                onClick={() => setDistributionTimeRange('24h')}
                style={timeRangeButtonStyle(distributionTimeRange === '24h')}
              >
                {t('info.last_24_hours')}
              </button>
              <button
                onClick={() => setDistributionTimeRange('all')}
                style={timeRangeButtonStyle(distributionTimeRange === 'all')}
              >
                {t('info.all_data')}
              </button>
            </div>
          );

          return (
            <>
              {loadingDistribution && (
                <div className="info-section">
                  <p>{t('common.loading_indicator')}</p>
                </div>
              )}

              {!loadingDistribution && packetDistribution.total > 0 && (
                <div className="info-section-wide">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                    <h3 style={{ margin: 0 }}>{t('info.packet_distribution', 'Packet Distribution')}</h3>
                    {timeRangeButtons}
                  </div>
                  <div className="packet-distribution-grid">
                    <PacketStatsChart
                      title={t('info.packets_by_device')}
                      data={deviceData}
                      total={packetDistribution.total}
                      chartId="dist-device"
                      bare
                      stacked
                    />
                    <PacketStatsChart
                      title={t('info.packets_by_type')}
                      data={typeData}
                      total={packetDistribution.total}
                      chartId="dist-type"
                      bare
                      stacked
                    />
                  </div>
                </div>
              )}

              {!loadingDistribution && packetDistribution.total === 0 && (
                <div className="info-section">
                  <p style={{ color: '#888', fontStyle: 'italic' }}>{t('info.no_packet_data')}</p>
                </div>
              )}
            </>
          );
        })()}

        {/* Per-portnum node distribution - separate section */}
        {packetDistribution?.enabled && packetDistribution.byType.length > 0 && (
          <div className="info-section">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
              <h3 style={{ margin: 0 }}>{t('info.packets_by_type_nodes')}</h3>
              <select
                id="portnum-select"
                value={selectedPortnum ?? ''}
                onChange={(e) => {
                  const val = e.target.value;
                  setSelectedPortnum(val ? parseInt(val, 10) : null);
                  if (!val) setPortnumNodeDistribution(null);
                }}
                style={{
                  padding: '0.25rem 0.5rem',
                  fontSize: '0.85em',
                  borderRadius: '4px',
                  border: '1px solid var(--ctp-surface2)',
                  background: 'var(--ctp-surface0)',
                  color: 'var(--ctp-text)',
                }}
              >
                <option value="">--</option>
                {[...packetDistribution.byType]
                  .sort((a, b) => b.count - a.count)
                  .map((p) => (
                    <option key={p.portnum} value={p.portnum}>
                      {p.portnum_name.replace(/_APP$/, '').replace(/_/g, ' ')} ({p.count})
                    </option>
                  ))}
              </select>
            </div>

            {selectedPortnum !== null && loadingPortnumNodes && (
              <p style={{ fontSize: '0.9em', color: '#888' }}>{t('common.loading_indicator')}</p>
            )}

            {selectedPortnum !== null && !loadingPortnumNodes && portnumNodeDistribution && (() => {
              if (portnumNodeDistribution.byDevice.length === 0) {
                return (
                  <p style={{ color: '#888', fontStyle: 'italic', fontSize: '0.9em' }}>
                    {t('info.no_packets_for_type')}
                  </p>
                );
              }

              const portnumDeviceData: ChartDataEntry[] = portnumNodeDistribution.byDevice.map((d, i) => ({
                name: d.from_node_longName || d.from_node_id || `Node ${d.from_node}`,
                value: d.count,
                color: DISTRIBUTION_COLORS[i % DISTRIBUTION_COLORS.length]
              }));

              const portnumDeviceTotal = portnumDeviceData.reduce((sum, d) => sum + d.value, 0);
              const portnumOtherCount = portnumNodeDistribution.total - portnumDeviceTotal;
              if (portnumOtherCount > 0) {
                portnumDeviceData.push({
                  name: t('info.other_devices'),
                  value: portnumOtherCount,
                  color: DISTRIBUTION_COLORS[10]
                });
              }

              const selectedTypeName = packetDistribution.byType
                .find((p) => p.portnum === selectedPortnum)
                ?.portnum_name.replace(/_APP$/, '').replace(/_/g, ' ') ?? `Port ${selectedPortnum}`;

              return (
                <PacketStatsChart
                  title={t('info.nodes_sending_type', { type: selectedTypeName })}
                  data={portnumDeviceData}
                  total={portnumNodeDistribution.total}
                  chartId="portnum-nodes"
                  bare
                  stacked
                />
              );
            })()}

            {selectedPortnum === null && (
              <p style={{ color: '#888', fontStyle: 'italic', fontSize: '0.9em' }}>
                {t('info.select_packet_type')}
              </p>
            )}
          </div>
        )}

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
          <p><strong>{t('info.last_message')}</strong> {(() => {
            // Combine all messages from DMs and all channels
            const allMessages = [
              ...messages,
              ...Object.values(channelMessages).flat()
            ];
            if (allMessages.length === 0) return t('common.none');
            const mostRecent = allMessages.reduce((latest, msg) =>
              msg.timestamp.getTime() > latest.timestamp.getTime() ? msg : latest
            );
            return formatDateTime(mostRecent.timestamp, timeFormat, dateFormat);
          })()}</p>
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

      {currentNodeId && connectionStatus === 'connected' && (
        <div className="info-section-full-width">
          <PacketRateGraphs nodeId={currentNodeId} telemetryHours={telemetryHours} baseUrl={baseUrl} />
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