import React from 'react';
import { DeviceInfo, Channel } from '../types/device';
import { MeshMessage } from '../types/message';
import { ConnectionStatus } from '../types/ui';
import { TemperatureUnit } from '../utils/temperature';
import TelemetryGraphs from './TelemetryGraphs';
import { version } from '../../package.json';

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
  getAvailableChannels: () => number[];
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
  getAvailableChannels
}) => {
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
              <p><strong>Region:</strong> {deviceConfig.radio?.region || 'Unknown'}</p>
              <p><strong>Modem Preset:</strong> {deviceConfig.radio?.modemPreset || 'Unknown'}</p>
              <p><strong>Hop Limit:</strong> {deviceConfig.radio?.hopLimit || 'Unknown'}</p>
              <p><strong>TX Power:</strong> {deviceConfig.radio?.txPower ? `${deviceConfig.radio.txPower} dBm` : 'Unknown'}</p>
              <p><strong>Bandwidth:</strong> {deviceConfig.radio?.bandwidth ? `${deviceConfig.radio.bandwidth} kHz` : 'Unknown'}</p>
              <p><strong>Spread Factor:</strong> {deviceConfig.radio?.spreadFactor || 'Unknown'}</p>
              <p><strong>Coding Rate:</strong> {deviceConfig.radio?.codingRate || 'Unknown'}</p>
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

        {!deviceConfig && (
          <div className="info-section">
            <p className="no-data">Device configuration not available. Ensure connection is established.</p>
          </div>
        )}
      </div>

      {currentNodeId && connectionStatus === 'connected' && (
        <div className="info-section-full-width">
          <h3>Local Node Telemetry</h3>
          <TelemetryGraphs nodeId={currentNodeId} temperatureUnit={temperatureUnit} />
        </div>
      )}
    </div>
  );
};

export default InfoTab;