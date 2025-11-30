import React, { useState, useEffect, useCallback } from 'react';
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
      showToast('Record holder cleared successfully', 'success');
    } catch (error) {
      logger.error('Error clearing record holder:', error);
      if (error instanceof Error && error.message.includes('403')) {
        showToast('Insufficient permissions to clear record holder', 'error');
      } else {
        showToast('Failed to clear record holder. Please try again.', 'error');
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
      <h2>Device Information & Configuration</h2>
      <div className="device-info">
        <div className="info-section">
          <h3>Connection Status</h3>
          {isAuthenticated && (
            <p><strong>Node Address:</strong> {nodeAddress}</p>
          )}
          {deviceConfig?.basic?.nodeId && (
            <p><strong>Node ID:</strong> {deviceConfig.basic.nodeId}</p>
          )}
          {deviceConfig?.basic?.nodeName && (
            <p><strong>Node Name:</strong> {deviceConfig.basic.nodeName}</p>
          )}
          {deviceConfig?.basic && (
            <p><strong>Firmware Version:</strong> {deviceConfig.basic.firmwareVersion || 'Not available'}</p>
          )}
          <p><strong>Connection Status:</strong> <span className={`status-text ${connectionStatus}`}>{connectionStatus}</span></p>
          {(localStats?.uptimeSeconds !== undefined || localStats?.hostUptimeSeconds !== undefined) && (
            <p><strong>Uptime:</strong> {formatUptime(localStats.hostUptimeSeconds ?? localStats.uptimeSeconds)}</p>
          )}
          <p><strong>Uses TLS:</strong> {deviceInfo?.meshtasticUseTls ? 'Yes' : 'No'}</p>
          {deviceInfo?.deviceMetadata?.rebootCount !== undefined && (
            <p><strong>Reboot Count:</strong> {deviceInfo.deviceMetadata.rebootCount}</p>
          )}
        </div>

        {deviceConfig && (
          <>
            <div className="info-section">
              <h3>LoRa Radio Configuration</h3>
              {(() => {
                const localNode = nodes.find(n => n.user?.id === currentNodeId);
                const roleName = getDeviceRoleName(localNode?.user?.role);
                return <p><strong>Device Role:</strong> {roleName}</p>;
              })()}
              <p><strong>Region:</strong> {deviceConfig.radio?.region || 'Unknown'}</p>
              <p><strong>Modem Preset:</strong> {deviceConfig.radio?.modemPreset || 'Unknown'}</p>
              <p><strong>Channel Number:</strong> {deviceConfig.radio?.channelNum !== undefined ? deviceConfig.radio.channelNum : 'Unknown'}</p>
              <p><strong>Frequency:</strong> {deviceConfig.radio?.frequency || 'Unknown'}</p>
              <p><strong>Hop Limit:</strong> {deviceConfig.radio?.hopLimit !== undefined ? deviceConfig.radio.hopLimit : 'Unknown'}</p>
              <p><strong>TX Power:</strong> {deviceConfig.radio?.txPower !== undefined ? `${deviceConfig.radio.txPower} dBm` : 'Unknown'}</p>
              <p><strong>TX Enabled:</strong> {deviceConfig.radio?.txEnabled !== undefined ? (deviceConfig.radio.txEnabled ? 'Yes' : 'No') : 'Unknown'}</p>
              <p><strong>Boosted RX Gain:</strong> {deviceConfig.radio?.sx126xRxBoostedGain !== undefined ? (deviceConfig.radio.sx126xRxBoostedGain ? 'Yes' : 'No') : 'Unknown'}</p>
            </div>

            {isAuthenticated && (
              <div className="info-section">
                <h3>MQTT Configuration</h3>
                <p><strong>Enabled:</strong> {deviceConfig.mqtt?.enabled ? 'Yes' : 'No'}</p>
                <p><strong>Server:</strong> {deviceConfig.mqtt?.server || 'Not configured'}</p>
                <p><strong>Username:</strong> {deviceConfig.mqtt?.username || 'Not set'}</p>
                <p><strong>Encryption Enabled:</strong> {deviceConfig.mqtt?.encryption ? 'Yes' : 'No'}</p>
                <p><strong>JSON Format:</strong> {deviceConfig.mqtt?.json ? 'Enabled' : 'Disabled'}</p>
                <p><strong>TLS Enabled:</strong> {deviceConfig.mqtt?.tls ? 'Yes' : 'No'}</p>
                <p><strong>Root Topic:</strong> {deviceConfig.mqtt?.rootTopic || 'msh'}</p>
              </div>
            )}
          </>
        )}

        <div className="info-section">
          <h3>Application Information</h3>
          <p><strong>Version:</strong> {version}</p>
          {loadingServerInfo && <p>Loading...</p>}
          {!loadingServerInfo && serverInfo && (
            <p>
              <strong>Timezone:</strong> {serverInfo.timezone}
              {!serverInfo.timezoneProvided && (
                <span style={{ fontSize: '0.85em', color: '#888', marginLeft: '0.5rem' }}>
                  (default)
                </span>
              )}
            </p>
          )}
        </div>

        <div className="info-section">
          <h3>Virtual Node Server</h3>
          {loadingVirtualNode && <p>Loading...</p>}
          {!loadingVirtualNode && virtualNodeStatus && (
            <>
              <p><strong>Status:</strong> {virtualNodeStatus.enabled ? 'Enabled' : 'Disabled'}</p>
              {virtualNodeStatus.enabled && (
                <>
                  <p><strong>Server Running:</strong> {virtualNodeStatus.isRunning ? 'Yes' : 'No'}</p>
                  <p><strong>Connected Clients:</strong> {virtualNodeStatus.clientCount}</p>

                  {virtualNodeStatus.clients && virtualNodeStatus.clients.length > 0 && (
                    <div style={{ marginTop: '0.75rem', fontSize: '0.9em' }}>
                      <strong>Client Details:</strong>
                      {virtualNodeStatus.clients.map((client: any) => (
                        <div key={client.id} style={{
                          marginTop: '0.5rem',
                          padding: '0.5rem',
                          backgroundColor: 'var(--ctp-surface0)',
                          borderRadius: '4px'
                        }}>
                          <p style={{ margin: '0.25rem 0' }}><strong>ID:</strong> {client.id}</p>
                          <p style={{ margin: '0.25rem 0' }}><strong>IP:</strong> {client.ip}</p>
                          <p style={{ margin: '0.25rem 0' }}><strong>Connected:</strong> {formatDateTime(new Date(client.connectedAt), timeFormat, dateFormat)}</p>
                          <p style={{ margin: '0.25rem 0' }}><strong>Last Activity:</strong> {formatDateTime(new Date(client.lastActivity), timeFormat, dateFormat)}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              <p style={{ fontSize: '0.9em', color: '#888', marginTop: '0.75rem' }}>
                The Virtual Node Server allows multiple Meshtastic mobile apps to connect simultaneously, reducing load on your physical node.
              </p>
              <p style={{ fontSize: '0.85em', color: '#999', marginTop: '0.5rem', fontStyle: 'italic' }}>
                Note: Admin commands are blocked for security. See .env.example for configuration details.
              </p>
            </>
          )}
          {!loadingVirtualNode && !virtualNodeStatus && (
            <p className="no-data">Virtual Node status unavailable</p>
          )}
        </div>

        <div className="info-section">
          <h3>Network Statistics</h3>
          <p><strong>Total Nodes:</strong> {nodes.length}</p>
          <p><strong>Total Channels:</strong> {channels.length}</p>
          <p><strong>Total Messages:</strong> {messages.length}</p>
          <p><strong>Active Message Channels:</strong> {getAvailableChannels().length}</p>
          {localStats?.numPacketsTx !== undefined ? (
            <>
              <p><strong>Packets TX:</strong> {localStats.numPacketsTx.toLocaleString()}</p>
              <p><strong>Packets RX:</strong> {localStats.numPacketsRx?.toLocaleString() || 'N/A'}</p>
              <p><strong>RX Bad:</strong> {localStats.numPacketsRxBad?.toLocaleString() || '0'}</p>
              <p><strong>RX Duplicate:</strong> {localStats.numRxDupe?.toLocaleString() || '0'}</p>
              <p><strong>TX Dropped:</strong> {localStats.numTxDropped?.toLocaleString() || '0'}</p>
            </>
          ) : localStats?.hostUptimeSeconds !== undefined ? (
            <p style={{ fontSize: '0.9em', color: '#888', marginTop: '0.5rem' }}>
              Packet statistics not available. This device is sending HostMetrics (Linux-based device) instead of LocalStats.
            </p>
          ) : null}
        </div>

        {localStats?.hostUptimeSeconds !== undefined && (
          <div className="info-section">
            <h3>Host System Metrics</h3>
            <p style={{ fontSize: '0.9em', color: '#888', fontStyle: 'italic', marginBottom: '0.5rem' }}>
              Linux-based device telemetry
            </p>
            {localStats.hostUptimeSeconds !== undefined && (
              <p><strong>Host Uptime:</strong> {formatUptime(localStats.hostUptimeSeconds)}</p>
            )}
            {localStats.hostFreememBytes !== undefined && (
              <p><strong>Free Memory:</strong> {(localStats.hostFreememBytes / 1024 / 1024).toFixed(0)} MB</p>
            )}
            {localStats.hostDiskfree1Bytes !== undefined && (
              <p><strong>Disk Free (/):</strong> {(localStats.hostDiskfree1Bytes / 1024 / 1024 / 1024).toFixed(2)} GB</p>
            )}
            {localStats.hostDiskfree2Bytes !== undefined && (
              <p><strong>Disk Free (2):</strong> {(localStats.hostDiskfree2Bytes / 1024 / 1024 / 1024).toFixed(2)} GB</p>
            )}
            {localStats.hostDiskfree3Bytes !== undefined && (
              <p><strong>Disk Free (3):</strong> {(localStats.hostDiskfree3Bytes / 1024 / 1024 / 1024).toFixed(2)} GB</p>
            )}
            {localStats.hostLoad1 !== undefined && (
              <p><strong>Load Average:</strong> {(localStats.hostLoad1 / 100).toFixed(2)} / {(localStats.hostLoad5 / 100).toFixed(2)} / {(localStats.hostLoad15 / 100).toFixed(2)}</p>
            )}
          </div>
        )}

        <div className="info-section">
          <h3>Recent Activity</h3>
          <p><strong>Last Message:</strong> {messages.length > 0 ? formatDateTime(messages[0].timestamp, timeFormat, dateFormat) : 'None'}</p>
          <p><strong>Most Active Node:</strong> {
            nodes.length > 0 ?
            nodes.reduce((prev, current) =>
              (prev.lastHeard || 0) > (current.lastHeard || 0) ? prev : current
            ).user?.longName || 'Unknown' : 'None'
          }</p>
        </div>

        <div className="info-section">
          <h3>Longest Active Route Segment</h3>
          {loadingSegments && <p>Loading...</p>}
          {!loadingSegments && longestActiveSegment && (
            <>
              <p><strong>Distance:</strong> {formatDistance(longestActiveSegment.distanceKm, distanceUnit)}</p>
              <p><strong>From:</strong> {longestActiveSegment.fromNodeName} ({longestActiveSegment.fromNodeId})</p>
              <p><strong>To:</strong> {longestActiveSegment.toNodeName} ({longestActiveSegment.toNodeId})</p>
              <p style={{ fontSize: '0.85em', color: '#888' }}>
                Last seen: {formatDateTime(new Date(longestActiveSegment.timestamp), timeFormat, dateFormat)}
              </p>
            </>
          )}
          {!loadingSegments && !longestActiveSegment && (
            <p className="no-data">No active route segments found</p>
          )}
        </div>

        <div className="info-section">
          <h3>Record Holder Route Segment</h3>
          {loadingSegments && <p>Loading...</p>}
          {!loadingSegments && recordHolderSegment && (
            <>
              <p><strong>Distance:</strong> {formatDistance(recordHolderSegment.distanceKm, distanceUnit)} 🏆</p>
              <p><strong>From:</strong> {recordHolderSegment.fromNodeName} ({recordHolderSegment.fromNodeId})</p>
              <p><strong>To:</strong> {recordHolderSegment.toNodeName} ({recordHolderSegment.toNodeId})</p>
              <p style={{ fontSize: '0.85em', color: '#888' }}>
                Achieved: {formatDateTime(new Date(recordHolderSegment.timestamp), timeFormat, dateFormat)}
              </p>
              {isAuthenticated && (
                <button
                  onClick={handleClearRecordClick}
                  className="danger-button"
                  style={{ marginTop: '8px' }}
                >
                  Clear Record
                </button>
              )}
            </>
          )}
          {!loadingSegments && !recordHolderSegment && (
            <p className="no-data">No record holder set yet</p>
          )}
        </div>

        {!deviceConfig && (
          <div className="info-section">
            <p className="no-data">Device configuration not available. Ensure connection is established.</p>
          </div>
        )}
      </div>

      {currentNodeId && connectionStatus === 'connected' && (
        <div className="info-section-full-width">
          <h3>Local Node Telemetry</h3>
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
            <h3 style={{ marginTop: 0 }}>Clear Record Holder?</h3>
            <p>Are you sure you want to clear the record holder? This action cannot be undone.</p>
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
              <button
                onClick={handleCancelConfirm}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmClear}
                className="danger-button"
              >
                Clear Record
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