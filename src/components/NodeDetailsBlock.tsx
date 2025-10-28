import React from 'react';
import { DeviceInfo } from '../types/device';
import { getHardwareModelShortName } from '../utils/hardwareModel';
import { getDeviceRoleName } from '../utils/deviceRole';
import { getHardwareImageUrl } from '../utils/hardwareImages';
import { formatRelativeTime } from '../utils/datetime';
import { TimeFormat, DateFormat } from '../contexts/SettingsContext';
import './NodeDetailsBlock.css';

interface NodeDetailsBlockProps {
  node: DeviceInfo | null;
  timeFormat?: TimeFormat;
  dateFormat?: DateFormat;
}

const NodeDetailsBlock: React.FC<NodeDetailsBlockProps> = ({ node, timeFormat = '24', dateFormat = 'MM/DD/YYYY' }) => {
  if (!node) {
    return null;
  }

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
   * Format last heard timestamp
   */
  const formatLastHeard = (lastHeard: number | undefined): string => {
    if (lastHeard === undefined || lastHeard === null) return 'N/A';
    return formatRelativeTime(lastHeard * 1000, timeFormat, dateFormat, false);
  };

  const { deviceMetrics, snr, rssi, lastHeard, hopsAway, viaMqtt, user, firmwareVersion } = node;
  const hwModel = user?.hwModel;
  const role = user?.role;
  const hardwareImageUrl = getHardwareImageUrl(hwModel);

  return (
    <div className="node-details-block">
      <h3 className="node-details-title">Node Details</h3>
      <div className="node-details-grid">
        {/* Battery Status */}
        {(deviceMetrics?.batteryLevel !== undefined || deviceMetrics?.voltage !== undefined) && (
          <div className="node-detail-card">
            <div className="node-detail-label">Battery</div>
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
            <div className="node-detail-label">Signal (SNR)</div>
            <div className={`node-detail-value ${getSignalClass(snr)}`}>
              {formatSNR(snr)}
            </div>
          </div>
        )}

        {/* Signal Quality - RSSI */}
        {rssi !== undefined && (
          <div className="node-detail-card">
            <div className="node-detail-label">Signal (RSSI)</div>
            <div className="node-detail-value">
              {formatRSSI(rssi)}
            </div>
          </div>
        )}

        {/* Channel Utilization */}
        {deviceMetrics?.channelUtilization !== undefined && (
          <div className="node-detail-card">
            <div className="node-detail-label">Channel Utilization</div>
            <div className={`node-detail-value ${getUtilizationClass(deviceMetrics.channelUtilization)}`}>
              {formatUtilization(deviceMetrics.channelUtilization)}
            </div>
          </div>
        )}

        {/* Air Utilization TX */}
        {deviceMetrics?.airUtilTx !== undefined && (
          <div className="node-detail-card">
            <div className="node-detail-label">Air Utilization TX</div>
            <div className={`node-detail-value ${getUtilizationClass(deviceMetrics.airUtilTx)}`}>
              {formatUtilization(deviceMetrics.airUtilTx)}
            </div>
          </div>
        )}

        {/* Hardware Model */}
        {hwModel !== undefined && (
          <div className="node-detail-card node-detail-card-hardware">
            <div className="node-detail-label">Hardware</div>
            <div className="node-detail-value node-detail-hardware-content">
              {hardwareImageUrl && (
                <img
                  src={hardwareImageUrl}
                  alt={getHardwareModelShortName(hwModel)}
                  className="hardware-image"
                />
              )}
              <span className="hardware-name">{getHardwareModelShortName(hwModel)}</span>
            </div>
          </div>
        )}

        {/* Role */}
        {role !== undefined && (
          <div className="node-detail-card">
            <div className="node-detail-label">Role</div>
            <div className="node-detail-value">
              {getDeviceRoleName(role)}
            </div>
          </div>
        )}

        {/* Firmware Version */}
        {firmwareVersion && (
          <div className="node-detail-card">
            <div className="node-detail-label">Firmware</div>
            <div className="node-detail-value">
              {firmwareVersion}
            </div>
          </div>
        )}

        {/* Hops Away */}
        {hopsAway !== undefined && (
          <div className="node-detail-card">
            <div className="node-detail-label">Hops Away</div>
            <div className="node-detail-value">
              {hopsAway === 0 ? 'Direct' : `${hopsAway} hop${hopsAway !== 1 ? 's' : ''}`}
            </div>
          </div>
        )}

        {/* Via MQTT */}
        {viaMqtt && (
          <div className="node-detail-card">
            <div className="node-detail-label">Connection</div>
            <div className="node-detail-value">
              Via MQTT
            </div>
          </div>
        )}

        {/* Last Heard */}
        {lastHeard !== undefined && (
          <div className="node-detail-card">
            <div className="node-detail-label">Last Heard</div>
            <div className="node-detail-value">
              {formatLastHeard(lastHeard)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default NodeDetailsBlock;
