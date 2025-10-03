import React, { useState, useEffect } from 'react';
import { DeviceInfo, Channel } from '../types/device';
import { MeshMessage } from '../types/message';
import { ConnectionStatus } from '../types/ui';
import { TemperatureUnit } from '../utils/temperature';
import TelemetryGraphs from './TelemetryGraphs';
import { version } from '../../package.json';
import apiService from '../services/api';
import { formatDistance } from '../utils/distance';

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
}

const InfoTab: React.FC<InfoTabProps> = ({
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
  distanceUnit = 'km'
}) => {
  const [longestActiveSegment, setLongestActiveSegment] = useState<RouteSegment | null>(null);
  const [recordHolderSegment, setRecordHolderSegment] = useState<RouteSegment | null>(null);
  const [loadingSegments, setLoadingSegments] = useState(false);

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
      console.error('Error fetching route segments:', error);
    } finally {
      setLoadingSegments(false);
    }
  };

  const handleClearRecordHolder = async () => {
    if (!confirm('Are you sure you want to clear the record holder?')) {
      return;
    }

    try {
      await apiService.clearRecordHolderSegment();
      setRecordHolderSegment(null);
    } catch (error) {
      console.error('Error clearing record holder:', error);
      alert('Failed to clear record holder');
    }
  };

  useEffect(() => {
    fetchRouteSegments();
    const interval = setInterval(fetchRouteSegments, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, [connectionStatus]);

  return (
    <div className="tab-content">
      <h2>Device Information & Configuration</h2>
      <div className="device-info">
        <div className="info-section">
          <h3>Connection Status</h3>
          <p><strong>Node Address:</strong> {nodeAddress}</p>
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
          <p><strong>Uses TLS:</strong> {deviceInfo?.meshtasticUseTls ? 'Yes' : 'No'}</p>
        </div>

        {deviceConfig && (
          <>
            <div className="info-section">
              <h3>LoRa Radio Configuration</h3>
              {(deviceConfig.radio?.region !== 'Unknown' || deviceConfig.radio?.modemPreset !== 'Unknown') &&
                deviceConfig.radio?.modemPreset !== 'Long Fast' && deviceConfig.radio?.modemPreset !== 'Short Fast' && (
                <p style={{ fontSize: '0.9em', fontStyle: 'italic', color: '#888' }}>
                  ⚠️ Some values are inferred from available data when device config is not fully accessible via HTTP API
                </p>
              )}
              <p><strong>Region:</strong> {deviceConfig.radio?.region || 'Unknown'}</p>
              <p><strong>Modem Preset:</strong> {deviceConfig.radio?.modemPreset || 'Unknown'}</p>
              <p><strong>Channel Number:</strong> {deviceConfig.radio?.channelNum !== undefined ? deviceConfig.radio.channelNum : 'Unknown'}</p>
              <p><strong>Frequency:</strong> {deviceConfig.radio?.frequency || 'Unknown'}</p>
              <p><strong>Hop Limit:</strong> {deviceConfig.radio?.hopLimit !== undefined ? deviceConfig.radio.hopLimit : 'Unknown'}</p>
              <p><strong>TX Power:</strong> {deviceConfig.radio?.txPower !== undefined ? `${deviceConfig.radio.txPower} dBm` : 'Unknown'}</p>
              <p><strong>TX Enabled:</strong> {deviceConfig.radio?.txEnabled !== undefined ? (deviceConfig.radio.txEnabled ? 'Yes' : 'No') : 'Unknown'}</p>
              <p><strong>Boosted RX Gain:</strong> {deviceConfig.radio?.sx126xRxBoostedGain !== undefined ? (deviceConfig.radio.sx126xRxBoostedGain ? 'Yes' : 'No') : 'Unknown'}</p>
            </div>

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
          </>
        )}

        <div className="info-section">
          <h3>Application Information</h3>
          <p><strong>Version:</strong> {version}</p>
        </div>

        <div className="info-section">
          <h3>Network Statistics</h3>
          <p><strong>Total Nodes:</strong> {nodes.length}</p>
          <p><strong>Total Channels:</strong> {channels.length}</p>
          <p><strong>Total Messages:</strong> {messages.length}</p>
          <p><strong>Active Message Channels:</strong> {getAvailableChannels().length}</p>
        </div>

        <div className="info-section">
          <h3>Recent Activity</h3>
          <p><strong>Last Message:</strong> {messages.length > 0 ? messages[0].timestamp.toLocaleString() : 'None'}</p>
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
                Last seen: {new Date(longestActiveSegment.timestamp).toLocaleString()}
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
                Achieved: {new Date(recordHolderSegment.timestamp).toLocaleString()}
              </p>
              <button
                onClick={handleClearRecordHolder}
                className="danger-button"
                style={{ marginTop: '8px' }}
              >
                Clear Record
              </button>
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
    </div>
  );
};

export default InfoTab;