import React, { useState, useEffect } from 'react';
import apiService from '../services/api';
import { useToast } from './ToastContainer';
import type { DeviceInfo, Channel } from '../types/device';
import { logger } from '../utils/logger';
import NodeIdentitySection from './configuration/NodeIdentitySection';
import DeviceConfigSection from './configuration/DeviceConfigSection';
import LoRaConfigSection from './configuration/LoRaConfigSection';
import PositionConfigSection from './configuration/PositionConfigSection';
import MQTTConfigSection from './configuration/MQTTConfigSection';
import NeighborInfoSection from './configuration/NeighborInfoSection';
import ChannelsConfigSection from './configuration/ChannelsConfigSection';
import BackupManagementSection from './configuration/BackupManagementSection';
import { ImportConfigModal } from './configuration/ImportConfigModal';
import { ExportConfigModal } from './configuration/ExportConfigModal';
import { ROLE_MAP, PRESET_MAP, REGION_MAP } from './configuration/constants';

interface ConfigurationTabProps {
  baseUrl?: string; // Optional, not used in component but passed from App.tsx
  nodes?: DeviceInfo[]; // Pass nodes from App to avoid separate API call
  channels?: Channel[]; // Pass channels from App
  onRebootDevice?: () => Promise<boolean>;
  onConfigChangeTriggeringReboot?: () => void;
  onChannelsUpdated?: () => void; // Callback when channels are updated
  refreshTrigger?: number; // Increment this to trigger config refresh
}

const ConfigurationTab: React.FC<ConfigurationTabProps> = ({ nodes, channels = [], onRebootDevice, onConfigChangeTriggeringReboot, onChannelsUpdated, refreshTrigger }) => {
  const { showToast } = useToast();

  // Device Config State
  const [longName, setLongName] = useState('');
  const [shortName, setShortName] = useState('');
  const [role, setRole] = useState<number>(0);
  const [nodeInfoBroadcastSecs, setNodeInfoBroadcastSecs] = useState(3600);

  // LoRa Config State
  const [usePreset, setUsePreset] = useState(true);
  const [modemPreset, setModemPreset] = useState<number>(0);
  const [region, setRegion] = useState<number>(0);
  const [hopLimit, setHopLimit] = useState<number>(3);
  const [channelNum, setChannelNum] = useState<number>(0);
  const [sx126xRxBoostedGain, setSx126xRxBoostedGain] = useState<boolean>(false);

  // Position Config State
  const [positionBroadcastSecs, setPositionBroadcastSecs] = useState(900);
  const [positionSmartEnabled, setPositionSmartEnabled] = useState(true);
  const [fixedPosition, setFixedPosition] = useState(false);
  const [fixedLatitude, setFixedLatitude] = useState<number>(0);
  const [fixedLongitude, setFixedLongitude] = useState<number>(0);
  const [fixedAltitude, setFixedAltitude] = useState<number>(0);

  // MQTT Config State
  const [mqttEnabled, setMqttEnabled] = useState(false);
  const [mqttAddress, setMqttAddress] = useState('');
  const [mqttUsername, setMqttUsername] = useState('');
  const [mqttPassword, setMqttPassword] = useState('');
  const [mqttEncryptionEnabled, setMqttEncryptionEnabled] = useState(true);
  const [mqttJsonEnabled, setMqttJsonEnabled] = useState(false);
  const [mqttRoot, setMqttRoot] = useState('');

  // NeighborInfo Config State
  const [neighborInfoEnabled, setNeighborInfoEnabled] = useState(false);
  const [neighborInfoInterval, setNeighborInfoInterval] = useState(14400);

  // UI State
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  // Import/Export Modal State
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);

  // Fetch current configuration on mount (run once only)
  useEffect(() => {
    const fetchConfig = async () => {
      console.log(`[ConfigurationTab] useEffect triggered - refreshTrigger=${refreshTrigger}`);
      try {
        setIsLoading(true);
        console.log('[ConfigurationTab] Fetching config from API...');
        const config = await apiService.getCurrentConfig();
        console.log('[ConfigurationTab] Received config:', config);

        // Populate node info from localNodeInfo
        if (config.localNodeInfo) {
          setLongName(config.localNodeInfo.longName || '');
          setShortName(config.localNodeInfo.shortName || '');
        }

        // Populate device config
        if (config.deviceConfig?.device) {
          if (config.deviceConfig.device.role !== undefined) {
            const roleValue = typeof config.deviceConfig.device.role === 'string'
              ? ROLE_MAP[config.deviceConfig.device.role] || 0
              : config.deviceConfig.device.role;
            setRole(roleValue);
          }
          if (config.deviceConfig.device.nodeInfoBroadcastSecs !== undefined) {
            setNodeInfoBroadcastSecs(config.deviceConfig.device.nodeInfoBroadcastSecs);
          }
        }

        // Populate LoRa config
        if (config.deviceConfig?.lora) {
          if (config.deviceConfig.lora.usePreset !== undefined) {
            setUsePreset(config.deviceConfig.lora.usePreset);
          }
          if (config.deviceConfig.lora.modemPreset !== undefined) {
            const presetValue = typeof config.deviceConfig.lora.modemPreset === 'string'
              ? PRESET_MAP[config.deviceConfig.lora.modemPreset] || 0
              : config.deviceConfig.lora.modemPreset;
            setModemPreset(presetValue);
          }
          if (config.deviceConfig.lora.region !== undefined) {
            const regionValue = typeof config.deviceConfig.lora.region === 'string'
              ? REGION_MAP[config.deviceConfig.lora.region] || 0
              : config.deviceConfig.lora.region;
            setRegion(regionValue);
          }
          if (config.deviceConfig.lora.hopLimit !== undefined) {
            console.log(`[ConfigurationTab] Setting hopLimit to: ${config.deviceConfig.lora.hopLimit}`);
            setHopLimit(config.deviceConfig.lora.hopLimit);
          }
          if (config.deviceConfig.lora.channelNum !== undefined) {
            setChannelNum(config.deviceConfig.lora.channelNum);
          }
          if (config.deviceConfig.lora.sx126xRxBoostedGain !== undefined) {
            setSx126xRxBoostedGain(config.deviceConfig.lora.sx126xRxBoostedGain);
          }
        }

        // Populate position config
        if (config.deviceConfig?.position) {
          if (config.deviceConfig.position.positionBroadcastSecs !== undefined) {
            setPositionBroadcastSecs(config.deviceConfig.position.positionBroadcastSecs);
          }
          if (config.deviceConfig.position.positionBroadcastSmartEnabled !== undefined) {
            setPositionSmartEnabled(config.deviceConfig.position.positionBroadcastSmartEnabled);
          }
          if (config.deviceConfig.position.fixedPosition !== undefined) {
            setFixedPosition(config.deviceConfig.position.fixedPosition);
          }
        }

        // Populate MQTT config
        if (config.moduleConfig?.mqtt) {
          setMqttEnabled(config.moduleConfig.mqtt.enabled || false);
          setMqttAddress(config.moduleConfig.mqtt.address || '');
          setMqttUsername(config.moduleConfig.mqtt.username || '');
          setMqttPassword(config.moduleConfig.mqtt.password || '');
          setMqttEncryptionEnabled(config.moduleConfig.mqtt.encryptionEnabled !== false);
          setMqttJsonEnabled(config.moduleConfig.mqtt.jsonEnabled || false);
          setMqttRoot(config.moduleConfig.mqtt.root || '');
        }

        // Populate NeighborInfo config
        if (config.moduleConfig?.neighborInfo) {
          setNeighborInfoEnabled(config.moduleConfig.neighborInfo.enabled || false);
          setNeighborInfoInterval(config.moduleConfig.neighborInfo.updateInterval || 14400);
        }
      } catch (error) {
        logger.error('Error fetching configuration:', error);
        setStatusMessage('Warning: Could not load current configuration. Default values shown.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchConfig();
  }, [refreshTrigger]); // Re-run when refreshTrigger changes

  // Separate effect to load position data when nodes become available
  // This runs independently of config loading to avoid re-fetching config
  useEffect(() => {
    const loadPositionFromNodes = async () => {
      if (!nodes || nodes.length === 0) return;

      // Only load position if we haven't already loaded it
      if (fixedLatitude !== 0 || fixedLongitude !== 0) return;

      try {
        const config = await apiService.getCurrentConfig();
        if (config.localNodeInfo?.nodeNum) {
          const localNode = nodes.find((n: any) => n.nodeNum === config.localNodeInfo.nodeNum);
          logger.debug('🔍 Loading position from nodes:', config.localNodeInfo.nodeNum, 'found:', !!localNode);
          if (localNode?.position) {
            if (localNode.position.latitude !== undefined) {
              setFixedLatitude(localNode.position.latitude);
            }
            if (localNode.position.longitude !== undefined) {
              setFixedLongitude(localNode.position.longitude);
            }
            if (localNode.position.altitude !== undefined) {
              setFixedAltitude(localNode.position.altitude);
            }
          }
        }
      } catch (error) {
        logger.error('Failed to load position from nodes:', error);
      }
    };

    loadPositionFromNodes();
  }, [nodes]); // Run when nodes first populate

  const handleSaveDeviceConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      // Enforce minimum value for nodeInfoBroadcastSecs
      const validNodeInfoBroadcastSecs = Math.max(3600, nodeInfoBroadcastSecs);
      if (validNodeInfoBroadcastSecs !== nodeInfoBroadcastSecs) {
        setNodeInfoBroadcastSecs(validNodeInfoBroadcastSecs);
        showToast('Node Info Broadcast Interval adjusted to minimum value of 3600 seconds (1 hour)', 'warning');
        setIsSaving(false);
        return;
      }

      await apiService.setDeviceConfig({
        role,
        nodeInfoBroadcastSecs: validNodeInfoBroadcastSecs
      });
      setStatusMessage('Device configuration saved successfully! Device will reboot...');
      showToast('Device configuration saved! Device will reboot...', 'success');
      // Notify parent that config change will trigger reboot
      onConfigChangeTriggeringReboot?.();
    } catch (error) {
      logger.error('Error saving device config:', error);
      const errorMsg = error instanceof Error ? error.message : 'Failed to save device configuration';
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`Failed to save device configuration: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveNodeOwner = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setNodeOwner(longName, shortName);
      setStatusMessage('Node names saved successfully! Device will reboot...');
      showToast('Node names saved! Device will reboot...', 'success');
      onConfigChangeTriggeringReboot?.();
    } catch (error) {
      logger.error('Error saving node owner:', error);
      const errorMsg = error instanceof Error ? error.message : 'Failed to save node names';
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`Failed to save node names: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveLoRaConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      // Validate hop limit (max 7)
      const validHopLimit = Math.min(7, Math.max(1, hopLimit));
      if (validHopLimit !== hopLimit) {
        setHopLimit(validHopLimit);
        showToast(`Hop Limit adjusted to valid range (1-7)`, 'warning');
        setIsSaving(false);
        return;
      }

      await apiService.setLoRaConfig({
        usePreset,
        modemPreset,
        region,
        hopLimit: validHopLimit,
        channelNum,
        sx126xRxBoostedGain
      });
      setStatusMessage('LoRa configuration saved successfully! Device will reboot...');
      showToast('LoRa configuration saved! Device will reboot...', 'success');
      onConfigChangeTriggeringReboot?.();
    } catch (error) {
      logger.error('Error saving LoRa config:', error);
      const errorMsg = error instanceof Error ? error.message : 'Failed to save LoRa configuration';
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`Failed to save LoRa configuration: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSavePositionConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      // Enforce minimum value for positionBroadcastSecs (32 seconds minimum per Meshtastic docs)
      const validPositionBroadcastSecs = Math.max(32, positionBroadcastSecs);
      if (validPositionBroadcastSecs !== positionBroadcastSecs) {
        setPositionBroadcastSecs(validPositionBroadcastSecs);
        showToast('Position Broadcast Interval adjusted to minimum value of 32 seconds', 'warning');
        setIsSaving(false);
        return;
      }

      // Validate lat/long ranges if fixed position is enabled
      if (fixedPosition) {
        if (fixedLatitude < -90 || fixedLatitude > 90) {
          showToast('Latitude must be between -90 and 90', 'error');
          setIsSaving(false);
          return;
        }
        if (fixedLongitude < -180 || fixedLongitude > 180) {
          showToast('Longitude must be between -180 and 180', 'error');
          setIsSaving(false);
          return;
        }
      }

      await apiService.setPositionConfig({
        positionBroadcastSecs: validPositionBroadcastSecs,
        positionBroadcastSmartEnabled: positionSmartEnabled,
        fixedPosition,
        latitude: fixedPosition ? fixedLatitude : undefined,
        longitude: fixedPosition ? fixedLongitude : undefined,
        altitude: fixedPosition ? fixedAltitude : undefined
      });
      setStatusMessage('Position configuration saved successfully! Device will reboot...');
      showToast('Position configuration saved! Device will reboot...', 'success');
      onConfigChangeTriggeringReboot?.();
    } catch (error) {
      logger.error('Error saving position config:', error);
      const errorMsg = error instanceof Error ? error.message : 'Failed to save position configuration';
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`Failed to save position configuration: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveMQTTConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setMQTTConfig({
        enabled: mqttEnabled,
        address: mqttAddress,
        username: mqttUsername,
        password: mqttPassword,
        encryptionEnabled: mqttEncryptionEnabled,
        jsonEnabled: mqttJsonEnabled,
        root: mqttRoot
      });
      setStatusMessage('MQTT configuration saved successfully! Device will reboot...');
      showToast('MQTT configuration saved! Device will reboot...', 'success');
      onConfigChangeTriggeringReboot?.();
    } catch (error) {
      logger.error('Error saving MQTT config:', error);
      const errorMsg = error instanceof Error ? error.message : 'Failed to save MQTT configuration';
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`Failed to save MQTT configuration: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveNeighborInfoConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      // Enforce minimum interval
      const validInterval = Math.max(14400, neighborInfoInterval);
      if (validInterval !== neighborInfoInterval) {
        setNeighborInfoInterval(validInterval);
        showToast('NeighborInfo interval adjusted to minimum value of 14400 seconds (4 hours)', 'warning');
      }

      await apiService.setNeighborInfoConfig({
        enabled: neighborInfoEnabled,
        updateInterval: validInterval
      });
      setStatusMessage('NeighborInfo configuration saved successfully! Device will reboot...');
      showToast('NeighborInfo configuration saved! Device will reboot...', 'success');
      onConfigChangeTriggeringReboot?.();
    } catch (error) {
      logger.error('Error saving NeighborInfo config:', error);
      const errorMsg = error instanceof Error ? error.message : 'Failed to save NeighborInfo configuration';
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`Failed to save NeighborInfo configuration: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRebootDevice = async () => {
    const confirmed = window.confirm(
      'Are you sure you want to reboot the device?\n\n' +
      'The device will restart and be unavailable for approximately 30-60 seconds.'
    );

    if (!confirmed) {
      return;
    }

    setIsSaving(true);
    setStatusMessage('');
    try {
      if (onRebootDevice) {
        // Use the parent handler which manages connection status
        setStatusMessage('Rebooting device... This may take up to 60 seconds.');
        showToast('Rebooting device...', 'info');
        const success = await onRebootDevice();
        if (success) {
          setStatusMessage('Device rebooted successfully and reconnected!');
          showToast('Device rebooted successfully!', 'success');
        } else {
          setStatusMessage('Device reboot initiated, but failed to reconnect. Please check connection manually.');
          showToast('Device reboot initiated, but failed to reconnect', 'warning');
        }
      } else {
        // Fallback to direct API call if handler not provided
        await apiService.rebootDevice(5);
        setStatusMessage('Reboot command sent! Device will restart in 5 seconds.');
        showToast('Reboot command sent!', 'success');
      }
    } catch (error) {
      logger.error('Error rebooting device:', error);
      const errorMsg = error instanceof Error ? error.message : 'Failed to reboot device';
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`Failed to reboot device: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="tab-content">
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <p>Loading configuration...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tab-content">
      <div className="settings-section danger-zone" style={{ marginBottom: '2rem' }}>
        <h2 style={{ color: '#ff4444', marginTop: 0 }}>⚠️ WARNING</h2>
        <p style={{ fontSize: '1.1rem', fontWeight: 'bold' }}>
          Modifying these settings can break your Meshtastic node configuration.
        </p>
        <p>
          These settings directly modify the configuration of your locally connected Meshtastic device.
          Incorrect settings may cause communication issues, network problems, or require a factory reset.
          Only modify these settings if you understand what you are doing.
        </p>
        <div style={{ marginTop: '1.5rem' }}>
          <button
            onClick={handleRebootDevice}
            disabled={isSaving}
            style={{
              backgroundColor: '#ff6b6b',
              color: '#fff',
              padding: '0.75rem 1.5rem',
              border: 'none',
              borderRadius: '4px',
              cursor: isSaving ? 'not-allowed' : 'pointer',
              fontSize: '1rem',
              fontWeight: 'bold',
              opacity: isSaving ? 0.6 : 1
            }}
          >
            🔄 Reboot Device
          </button>
        </div>
      </div>

      {/* Import/Export Configuration Section */}
      <div className="settings-section" style={{ marginBottom: '2rem' }}>
        <h3>Configuration Import/Export</h3>
        <p style={{ color: 'var(--ctp-subtext0)', marginBottom: '1rem' }}>
          Import or export channel configurations and device settings in Meshtastic URL format.
          These URLs are compatible with the official Meshtastic apps.
        </p>
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem' }}>
          <button
            onClick={() => setIsImportModalOpen(true)}
            style={{
              backgroundColor: 'var(--ctp-blue)',
              color: '#fff',
              padding: '0.75rem 1.5rem',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '1rem',
              fontWeight: 'bold'
            }}
          >
            📥 Import Configuration
          </button>
          <button
            onClick={() => setIsExportModalOpen(true)}
            style={{
              backgroundColor: 'var(--ctp-green)',
              color: '#fff',
              padding: '0.75rem 1.5rem',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '1rem',
              fontWeight: 'bold'
            }}
          >
            📤 Export Configuration
          </button>
        </div>

      </div>

      {statusMessage && (
        <div
          className={statusMessage.startsWith('Error') ? 'error-message' : 'success-message'}
          style={{
            padding: '1rem',
            marginBottom: '1rem',
            borderRadius: '4px',
            backgroundColor: statusMessage.startsWith('Error') ? '#ffebee' : '#e8f5e9',
            color: statusMessage.startsWith('Error') ? '#c62828' : '#2e7d32',
            border: `1px solid ${statusMessage.startsWith('Error') ? '#ef5350' : '#66bb6a'}`
          }}
        >
          {statusMessage}
        </div>
      )}

      <div className="settings-content">
        <NodeIdentitySection
          longName={longName}
          shortName={shortName}
          setLongName={setLongName}
          setShortName={setShortName}
          isSaving={isSaving}
          onSave={handleSaveNodeOwner}
        />

        <DeviceConfigSection
          role={role}
          setRole={setRole}
          nodeInfoBroadcastSecs={nodeInfoBroadcastSecs}
          setNodeInfoBroadcastSecs={setNodeInfoBroadcastSecs}
          isSaving={isSaving}
          onSave={handleSaveDeviceConfig}
        />

        <LoRaConfigSection
          usePreset={usePreset}
          setUsePreset={setUsePreset}
          modemPreset={modemPreset}
          setModemPreset={setModemPreset}
          region={region}
          setRegion={setRegion}
          hopLimit={hopLimit}
          setHopLimit={setHopLimit}
          channelNum={channelNum}
          setChannelNum={setChannelNum}
          sx126xRxBoostedGain={sx126xRxBoostedGain}
          setSx126xRxBoostedGain={setSx126xRxBoostedGain}
          isSaving={isSaving}
          onSave={handleSaveLoRaConfig}
        />

        <PositionConfigSection
          positionBroadcastSecs={positionBroadcastSecs}
          setPositionBroadcastSecs={setPositionBroadcastSecs}
          positionSmartEnabled={positionSmartEnabled}
          setPositionSmartEnabled={setPositionSmartEnabled}
          fixedPosition={fixedPosition}
          setFixedPosition={setFixedPosition}
          fixedLatitude={fixedLatitude}
          setFixedLatitude={setFixedLatitude}
          fixedLongitude={fixedLongitude}
          setFixedLongitude={setFixedLongitude}
          fixedAltitude={fixedAltitude}
          setFixedAltitude={setFixedAltitude}
          isSaving={isSaving}
          onSave={handleSavePositionConfig}
        />

        <MQTTConfigSection
          mqttEnabled={mqttEnabled}
          setMqttEnabled={setMqttEnabled}
          mqttAddress={mqttAddress}
          setMqttAddress={setMqttAddress}
          mqttUsername={mqttUsername}
          setMqttUsername={setMqttUsername}
          mqttPassword={mqttPassword}
          setMqttPassword={setMqttPassword}
          mqttEncryptionEnabled={mqttEncryptionEnabled}
          setMqttEncryptionEnabled={setMqttEncryptionEnabled}
          mqttJsonEnabled={mqttJsonEnabled}
          setMqttJsonEnabled={setMqttJsonEnabled}
          mqttRoot={mqttRoot}
          setMqttRoot={setMqttRoot}
          isSaving={isSaving}
          onSave={handleSaveMQTTConfig}
        />

        <NeighborInfoSection
          neighborInfoEnabled={neighborInfoEnabled}
          setNeighborInfoEnabled={setNeighborInfoEnabled}
          neighborInfoInterval={neighborInfoInterval}
          setNeighborInfoInterval={setNeighborInfoInterval}
          isSaving={isSaving}
          onSave={handleSaveNeighborInfoConfig}
        />

        <ChannelsConfigSection
          channels={channels}
          onChannelsUpdated={onChannelsUpdated}
        />

        <BackupManagementSection />
      </div>

      {/* Import/Export Modals */}
      <ImportConfigModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImportSuccess={() => {
          showToast('Configuration imported successfully', 'success');
          if (onChannelsUpdated) onChannelsUpdated();
        }}
      />

      <ExportConfigModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        channels={channels}
        deviceConfig={{
          lora: {
            usePreset,
            modemPreset,
            region,
            hopLimit
          }
        }}
      />
    </div>
  );
};

export default ConfigurationTab;
