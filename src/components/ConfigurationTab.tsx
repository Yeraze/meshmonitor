import React, { useState, useEffect } from 'react';
import apiService from '../services/api';
import { useToast } from './ToastContainer';

interface ConfigurationTabProps {
  baseUrl?: string; // Optional, not used in component but passed from App.tsx
  onRebootDevice?: () => Promise<boolean>;
  onConfigChangeTriggeringReboot?: () => void;
}

const ConfigurationTab: React.FC<ConfigurationTabProps> = ({ onRebootDevice, onConfigChangeTriggeringReboot }) => {
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
  const [isRoleDropdownOpen, setIsRoleDropdownOpen] = useState(false);
  const [isPresetDropdownOpen, setIsPresetDropdownOpen] = useState(false);

  // Fetch current configuration on mount
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        setIsLoading(true);
        const config = await apiService.getCurrentConfig();

        // Populate node info from localNodeInfo
        if (config.localNodeInfo) {
          setLongName(config.localNodeInfo.longName || '');
          setShortName(config.localNodeInfo.shortName || '');
        }

        // Populate device config
        if (config.deviceConfig?.device) {
          if (config.deviceConfig.device.role !== undefined) {
            // Convert string role to number
            const roleMap: { [key: string]: number } = {
              'CLIENT': 0,
              'CLIENT_MUTE': 1,
              'ROUTER': 2,
              'TRACKER': 5,
              'SENSOR': 6,
              'TAK': 7,
              'CLIENT_HIDDEN': 8,
              'LOST_AND_FOUND': 9,
              'TAK_TRACKER': 10,
              'ROUTER_LATE': 11,
              'CLIENT_BASE': 12
            };
            const roleValue = typeof config.deviceConfig.device.role === 'string'
              ? roleMap[config.deviceConfig.device.role] || 0
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
            // Convert string preset to number
            const presetMap: { [key: string]: number } = {
              'LONG_FAST': 0,
              'LONG_SLOW': 1,
              'MEDIUM_SLOW': 3,
              'MEDIUM_FAST': 4,
              'SHORT_SLOW': 5,
              'SHORT_FAST': 6,
              'LONG_MODERATE': 7,
              'SHORT_TURBO': 8
            };
            const presetValue = typeof config.deviceConfig.lora.modemPreset === 'string'
              ? presetMap[config.deviceConfig.lora.modemPreset] || 0
              : config.deviceConfig.lora.modemPreset;
            setModemPreset(presetValue);
          }
          if (config.deviceConfig.lora.region !== undefined) {
            // Convert string region to number
            const regionMap: { [key: string]: number } = {
              'UNSET': 0, 'US': 1, 'EU_433': 2, 'EU_868': 3, 'CN': 4, 'JP': 5,
              'ANZ': 6, 'KR': 7, 'TW': 8, 'RU': 9, 'IN': 10, 'NZ_865': 11,
              'TH': 12, 'LORA_24': 13, 'UA_433': 14, 'UA_868': 15
            };
            const regionValue = typeof config.deviceConfig.lora.region === 'string'
              ? regionMap[config.deviceConfig.lora.region] || 0
              : config.deviceConfig.lora.region;
            setRegion(regionValue);
          }
          if (config.deviceConfig.lora.hopLimit !== undefined) {
            setHopLimit(config.deviceConfig.lora.hopLimit);
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

        // Populate fixed position from nodes list (get local node position)
        // The localNodeInfo doesn't include position, so we need to fetch it from nodes
        if (config.localNodeInfo?.nodeNum) {
          try {
            const nodesResponse = await apiService.getNodes();
            const localNode = nodesResponse.find((n: any) => n.nodeNum === config.localNodeInfo.nodeNum);
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
          } catch (error) {
            console.error('Failed to load node position:', error);
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
        console.error('Error fetching configuration:', error);
        setStatusMessage('Warning: Could not load current configuration. Default values shown.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchConfig();
  }, []);

  const roleOptions = [
    {
      value: 0,
      name: 'CLIENT',
      shortDesc: 'App connected or stand alone messaging device. Rebroadcasts packets when no other node has done so.',
      description: 'General use for individuals needing to communicate over the Meshtastic network with support for client applications.'
    },
    {
      value: 1,
      name: 'CLIENT_MUTE',
      shortDesc: 'Device that does not forward packets from other devices.',
      description: 'Situations where a device needs to participate in the network without assisting in packet routing, reducing network load.'
    },
    {
      value: 2,
      name: 'ROUTER',
      shortDesc: 'Infrastructure node for extending network coverage by always rebroadcasting packets once. Visible in Nodes list.',
      description: 'Best positioned in strategic locations to maximize the network\'s overall coverage. Device is shown in topology.'
    },
    {
      value: 5,
      name: 'TRACKER',
      shortDesc: 'Broadcasts GPS position packets as priority.',
      description: 'Tracking the location of individuals or assets, especially in scenarios where timely and efficient location updates are critical.'
    },
    {
      value: 6,
      name: 'SENSOR',
      shortDesc: 'Broadcasts telemetry packets as priority.',
      description: 'Deploying in scenarios where gathering environmental or other sensor data is crucial, with efficient power usage and frequent updates.'
    },
    {
      value: 7,
      name: 'TAK',
      shortDesc: 'Optimized for ATAK system communication, reduces routine broadcasts.',
      description: 'Integration with ATAK systems (via the Meshtastic ATAK Plugin) for communication in tactical or coordinated operations.'
    },
    {
      value: 8,
      name: 'CLIENT_HIDDEN',
      shortDesc: 'Device that only broadcasts as needed for stealth or power savings.',
      description: 'Use in stealth/hidden deployments or to reduce airtime/power consumption while still participating in the network.'
    },
    {
      value: 9,
      name: 'LOST_AND_FOUND',
      shortDesc: 'Broadcasts location as message to default channel regularly to assist with device recovery.',
      description: 'Used for recovery efforts of a lost device.'
    },
    {
      value: 10,
      name: 'TAK_TRACKER',
      shortDesc: 'Enables automatic TAK PLI broadcasts and reduces routine broadcasts.',
      description: 'Standalone PLI integration with ATAK systems for communication in tactical or coordinated operations.'
    },
    {
      value: 11,
      name: 'ROUTER_LATE',
      shortDesc: 'Infrastructure node that always rebroadcasts packets once but only after all other modes, ensuring additional coverage for local clusters. Visible in Nodes list.',
      description: 'Ideal for covering dead spots or ensuring reliability for a cluster of nodes where placement doesn\'t benefit the broader mesh. Device is shown in topology.'
    },
    {
      value: 12,
      name: 'CLIENT_BASE',
      shortDesc: 'Personal base station: always rebroadcasts packets from or to its favorited nodes. Handles all other packets like CLIENT.',
      description: 'Use for stronger attic/roof "base station" nodes to distribute messages more widely from your own weaker, indoor, or less-well-positioned nodes.'
    }
  ];

  const modemPresetOptions = [
    { value: 0, name: 'LONG_FAST', description: 'Long Range - Fast (Default)', params: 'BW: 250kHz, SF: 11, CR: 4/8' },
    { value: 1, name: 'LONG_SLOW', description: 'Long Range - Slow', params: 'BW: 250kHz, SF: 12, CR: 4/8' },
    { value: 3, name: 'MEDIUM_SLOW', description: 'Medium Range - Slow', params: 'BW: 250kHz, SF: 11, CR: 4/8' },
    { value: 4, name: 'MEDIUM_FAST', description: 'Medium Range - Fast', params: 'BW: 250kHz, SF: 10, CR: 4/7' },
    { value: 5, name: 'SHORT_SLOW', description: 'Short Range - Slow', params: 'BW: 250kHz, SF: 9, CR: 4/8' },
    { value: 6, name: 'SHORT_FAST', description: 'Short Range - Fast', params: 'BW: 250kHz, SF: 7, CR: 4/5' },
    { value: 7, name: 'LONG_MODERATE', description: 'Long Range - Moderately Fast', params: 'BW: 250kHz, SF: 11, CR: 4/6' },
    { value: 8, name: 'SHORT_TURBO', description: 'Short Range - Turbo (Fastest, widest bandwidth)', params: 'BW: 500kHz, SF: 7, CR: 4/5' }
  ];

  const regionOptions = [
    { value: 0, label: 'UNSET - Region not set' },
    { value: 1, label: 'US - United States' },
    { value: 2, label: 'EU_433 - European Union 433MHz' },
    { value: 3, label: 'EU_868 - European Union 868MHz' },
    { value: 4, label: 'CN - China' },
    { value: 5, label: 'JP - Japan' },
    { value: 6, label: 'ANZ - Australia / New Zealand' },
    { value: 7, label: 'KR - Korea' },
    { value: 8, label: 'TW - Taiwan' },
    { value: 9, label: 'RU - Russia' },
    { value: 10, label: 'IN - India' },
    { value: 11, label: 'NZ_865 - New Zealand 865MHz' },
    { value: 12, label: 'TH - Thailand' },
    { value: 13, label: 'LORA_24 - WLAN Band' },
    { value: 14, label: 'UA_433 - Ukraine 433MHz' },
    { value: 15, label: 'UA_868 - Ukraine 868MHz' }
  ];

  const handleRoleChange = (newRole: number) => {
    // Check if user is selecting ROUTER role (value 2)
    if (newRole === 2) {
      const confirmed = window.confirm(
        'Are you sure?\n\n' +
        'Setting the device role to ROUTER is generally not recommended for most users. ' +
        'ROUTER mode will cause your device to relay all packets, significantly increasing power consumption ' +
        'and airtime usage.\n\n' +
        'Click OK to confirm this change, or Cancel to keep your current setting.'
      );

      if (!confirmed) {
        // User cancelled, do not change role
        setIsRoleDropdownOpen(false);
        return;
      }
    }

    // Update role and close dropdown
    setRole(newRole);
    setIsRoleDropdownOpen(false);
  };

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
      console.error('Error saving device config:', error);
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
      console.error('Error saving node owner:', error);
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
        hopLimit: validHopLimit
      });
      setStatusMessage('LoRa configuration saved successfully! Device will reboot...');
      showToast('LoRa configuration saved! Device will reboot...', 'success');
      onConfigChangeTriggeringReboot?.();
    } catch (error) {
      console.error('Error saving LoRa config:', error);
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
      console.error('Error saving position config:', error);
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
      console.error('Error saving MQTT config:', error);
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
      console.error('Error saving NeighborInfo config:', error);
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
      console.error('Error rebooting device:', error);
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
        {/* Node Names Section */}
        <div className="settings-section">
          <h3>Node Identity</h3>
          <div className="setting-item">
            <label htmlFor="longName">
              Long Name
              <span className="setting-description">Full name for your node (up to 40 characters)</span>
            </label>
            <input
              id="longName"
              type="text"
              maxLength={40}
              value={longName}
              onChange={(e) => setLongName(e.target.value)}
              className="setting-input"
              placeholder="My Meshtastic Node"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="shortName">
              Short Name
              <span className="setting-description">Short identifier (up to 4 characters)</span>
            </label>
            <input
              id="shortName"
              type="text"
              maxLength={4}
              value={shortName}
              onChange={(e) => setShortName(e.target.value)}
              className="setting-input"
              placeholder="MESH"
            />
          </div>
          <button
            className="save-button"
            onClick={handleSaveNodeOwner}
            disabled={isSaving || !longName || !shortName}
          >
            {isSaving ? 'Saving...' : 'Save Node Names'}
          </button>
        </div>

        {/* Device Configuration Section */}
        <div className="settings-section">
          <h3>Device Configuration</h3>
          <div className="setting-item">
            <label htmlFor="role">
              Device Role
              <span className="setting-description">
                Defines how your node behaves on the mesh network.{' '}
                <a
                  href="https://meshtastic.org/docs/configuration/radio/device/#roles"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#4CAF50', textDecoration: 'underline' }}
                >
                  For more information
                </a>
              </span>
            </label>
            <div style={{ position: 'relative' }}>
              <div
                onClick={() => setIsRoleDropdownOpen(!isRoleDropdownOpen)}
                className="setting-input"
                style={{
                  cursor: 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '0.75rem',
                  minHeight: '80px',
                  width: '800px'
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 'bold', fontSize: '1.1em', color: '#fff', marginBottom: '0.5rem' }}>
                    {roleOptions.find(opt => opt.value === role)?.name || 'CLIENT'}
                  </div>
                  <div style={{ fontSize: '0.9em', color: '#ddd', marginBottom: '0.25rem', lineHeight: '1.4' }}>
                    {roleOptions.find(opt => opt.value === role)?.shortDesc || ''}
                  </div>
                  <div style={{ fontSize: '0.85em', color: '#bbb', fontStyle: 'italic', lineHeight: '1.4' }}>
                    {roleOptions.find(opt => opt.value === role)?.description || ''}
                  </div>
                </div>
                <span style={{ fontSize: '1.2em', marginLeft: '1rem', flexShrink: 0 }}>{isRoleDropdownOpen ? '▲' : '▼'}</span>
              </div>
              {isRoleDropdownOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    width: '800px',
                    backgroundColor: 'white',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    maxHeight: '500px',
                    overflowY: 'auto',
                    zIndex: 1000,
                    boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
                  }}
                >
                  {roleOptions.map(option => (
                    <div
                      key={option.value}
                      onClick={() => handleRoleChange(option.value)}
                      style={{
                        padding: '0.75rem 1rem',
                        cursor: 'pointer',
                        borderBottom: '1px solid #eee',
                        backgroundColor: option.value === role ? '#e3f2fd' : 'white',
                        transition: 'background-color 0.2s'
                      }}
                      onMouseEnter={(e) => {
                        if (option.value !== role) {
                          e.currentTarget.style.backgroundColor = '#f5f5f5';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (option.value !== role) {
                          e.currentTarget.style.backgroundColor = 'white';
                        }
                      }}
                    >
                      <div style={{ fontWeight: 'bold', fontSize: '1em', color: '#000', marginBottom: '0.4rem' }}>
                        {option.name}
                      </div>
                      <div style={{ fontSize: '0.9em', color: '#333', marginBottom: '0.3rem', lineHeight: '1.4' }}>
                        {option.shortDesc}
                      </div>
                      <div style={{ fontSize: '0.85em', color: '#555', fontStyle: 'italic', lineHeight: '1.4' }}>
                        {option.description}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="setting-item">
            <label htmlFor="nodeInfoBroadcastSecs">
              Node Info Broadcast Interval (seconds)
              <span className="setting-description">How often to broadcast node info. Range: 3600-4294967295 (default: 10800 = 3 hours, minimum: 3600 = 1 hour)</span>
            </label>
            <input
              id="nodeInfoBroadcastSecs"
              type="number"
              min="3600"
              max="4294967295"
              value={nodeInfoBroadcastSecs}
              onChange={(e) => setNodeInfoBroadcastSecs(parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
          <button
            className="save-button"
            onClick={handleSaveDeviceConfig}
            disabled={isSaving}
          >
            {isSaving ? 'Saving...' : 'Save Device Config'}
          </button>
        </div>

        {/* LoRa Configuration Section */}
        <div className="settings-section">
          <h3>LoRa Radio Configuration</h3>
          <div className="setting-item">
            <label htmlFor="usePreset" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="usePreset"
                type="checkbox"
                checked={usePreset}
                onChange={(e) => setUsePreset(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>Use Preset</div>
                <span className="setting-description">Use predefined modem settings (recommended)</span>
              </div>
            </label>
          </div>
          {usePreset && (
            <div className="setting-item">
              <label htmlFor="modemPreset">
                Modem Preset
                <span className="setting-description">Predefined radio settings balancing range and speed</span>
              </label>
              <div style={{ position: 'relative' }}>
                <div
                  onClick={() => setIsPresetDropdownOpen(!isPresetDropdownOpen)}
                  className="setting-input"
                  style={{
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.75rem',
                    minHeight: '60px',
                    width: '800px'
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '1.1em', color: '#fff', marginBottom: '0.4rem' }}>
                      {modemPresetOptions.find(opt => opt.value === modemPreset)?.name || 'LONG_FAST'}
                    </div>
                    <div style={{ fontSize: '0.9em', color: '#ddd', marginBottom: '0.2rem', lineHeight: '1.4' }}>
                      {modemPresetOptions.find(opt => opt.value === modemPreset)?.description || ''}
                    </div>
                    <div style={{ fontSize: '0.85em', color: '#bbb', fontStyle: 'italic', lineHeight: '1.4' }}>
                      {modemPresetOptions.find(opt => opt.value === modemPreset)?.params || ''}
                    </div>
                  </div>
                  <span style={{ fontSize: '1.2em', marginLeft: '1rem', flexShrink: 0 }}>{isPresetDropdownOpen ? '▲' : '▼'}</span>
                </div>
                {isPresetDropdownOpen && (
                  <div
                    style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      width: '800px',
                      backgroundColor: 'white',
                      border: '1px solid #ddd',
                      borderRadius: '4px',
                      maxHeight: '400px',
                      overflowY: 'auto',
                      zIndex: 1000,
                      boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
                    }}
                  >
                    {modemPresetOptions.map(option => (
                      <div
                        key={option.value}
                        onClick={() => {
                          setModemPreset(option.value);
                          setIsPresetDropdownOpen(false);
                        }}
                        style={{
                          padding: '0.75rem 1rem',
                          cursor: 'pointer',
                          borderBottom: '1px solid #eee',
                          backgroundColor: option.value === modemPreset ? '#e3f2fd' : 'white',
                          transition: 'background-color 0.2s'
                        }}
                        onMouseEnter={(e) => {
                          if (option.value !== modemPreset) {
                            e.currentTarget.style.backgroundColor = '#f5f5f5';
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (option.value !== modemPreset) {
                            e.currentTarget.style.backgroundColor = 'white';
                          }
                        }}
                      >
                        <div style={{ fontWeight: 'bold', fontSize: '1em', color: '#000', marginBottom: '0.3rem' }}>
                          {option.name}
                        </div>
                        <div style={{ fontSize: '0.9em', color: '#333', marginBottom: '0.2rem', lineHeight: '1.4' }}>
                          {option.description}
                        </div>
                        <div style={{ fontSize: '0.85em', color: '#555', fontStyle: 'italic', lineHeight: '1.4' }}>
                          {option.params}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="setting-item">
            <label htmlFor="region">
              Region Code
              <span className="setting-description">Select your regulatory region for frequency/power limits</span>
            </label>
            <select
              id="region"
              value={region}
              onChange={(e) => setRegion(parseInt(e.target.value))}
              className="setting-input"
            >
              {regionOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="hopLimit">
              Hop Limit
              <span className="setting-description">Maximum number of hops for mesh packets. Range: 1-7 (default: 3)</span>
            </label>
            <input
              id="hopLimit"
              type="number"
              min="1"
              max="7"
              value={hopLimit}
              onChange={(e) => setHopLimit(parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
          <button
            className="save-button"
            onClick={handleSaveLoRaConfig}
            disabled={isSaving}
          >
            {isSaving ? 'Saving...' : 'Save LoRa Config'}
          </button>
        </div>

        {/* Position Broadcast Section */}
        <div className="settings-section">
          <h3>Position Broadcast</h3>
          <div className="setting-item">
            <label htmlFor="positionBroadcastSecs">
              Position Broadcast Interval (seconds)
              <span className="setting-description">How often to broadcast position. Range: 32-4294967295 (default: 900 = 15 minutes, minimum: 32 seconds)</span>
            </label>
            <input
              id="positionBroadcastSecs"
              type="number"
              min="32"
              max="4294967295"
              value={positionBroadcastSecs}
              onChange={(e) => setPositionBroadcastSecs(parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="positionSmartEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="positionSmartEnabled"
                type="checkbox"
                checked={positionSmartEnabled}
                onChange={(e) => setPositionSmartEnabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>Smart Position Broadcast</div>
                <span className="setting-description">Only broadcast when position has changed significantly</span>
              </div>
            </label>
          </div>
          <div className="setting-item">
            <label htmlFor="fixedPosition" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="fixedPosition"
                type="checkbox"
                checked={fixedPosition}
                onChange={(e) => setFixedPosition(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>Fixed Position</div>
                <span className="setting-description">Node is at a fixed position (disables GPS updates)</span>
              </div>
            </label>
          </div>
          {fixedPosition && (
            <>
              <div className="setting-item">
                <label htmlFor="fixedLatitude">
                  Latitude
                  <span className="setting-description">
                    Range: -90 to 90 (decimal degrees) • <a href="https://gps-coordinates.org/" target="_blank" rel="noopener noreferrer" style={{ color: '#4a9eff', textDecoration: 'underline' }}>Find your GPS coordinates here</a>
                  </span>
                </label>
                <input
                  id="fixedLatitude"
                  type="number"
                  step="0.000001"
                  min="-90"
                  max="90"
                  value={fixedLatitude}
                  onChange={(e) => setFixedLatitude(parseFloat(e.target.value))}
                  className="setting-input"
                />
              </div>
              <div className="setting-item">
                <label htmlFor="fixedLongitude">
                  Longitude
                  <span className="setting-description">Range: -180 to 180 (decimal degrees)</span>
                </label>
                <input
                  id="fixedLongitude"
                  type="number"
                  step="0.000001"
                  min="-180"
                  max="180"
                  value={fixedLongitude}
                  onChange={(e) => setFixedLongitude(parseFloat(e.target.value))}
                  className="setting-input"
                />
              </div>
              <div className="setting-item">
                <label htmlFor="fixedAltitude">
                  Altitude (meters)
                  <span className="setting-description">Elevation above sea level in meters</span>
                </label>
                <input
                  id="fixedAltitude"
                  type="number"
                  step="1"
                  value={fixedAltitude}
                  onChange={(e) => setFixedAltitude(parseInt(e.target.value))}
                  className="setting-input"
                />
              </div>
            </>
          )}
          <button
            className="save-button"
            onClick={handleSavePositionConfig}
            disabled={isSaving}
          >
            {isSaving ? 'Saving...' : 'Save Position Config'}
          </button>
        </div>

        {/* MQTT Configuration Section */}
        <div className="settings-section">
          <h3>MQTT Module</h3>
          <div className="setting-item">
            <label htmlFor="mqttEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="mqttEnabled"
                type="checkbox"
                checked={mqttEnabled}
                onChange={(e) => setMqttEnabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>Enable MQTT</div>
                <span className="setting-description">Enable MQTT uplink/downlink gateway</span>
              </div>
            </label>
          </div>
          {mqttEnabled && (
            <>
              <div className="setting-item">
                <label htmlFor="mqttAddress">
                  MQTT Server Address
                  <span className="setting-description">Leave empty for default server (mqtt.meshtastic.org)</span>
                </label>
                <input
                  id="mqttAddress"
                  type="text"
                  value={mqttAddress}
                  onChange={(e) => setMqttAddress(e.target.value)}
                  className="setting-input"
                  placeholder="mqtt.meshtastic.org"
                />
              </div>
              <div className="setting-item">
                <label htmlFor="mqttUsername">
                  MQTT Username
                  <span className="setting-description">Username for MQTT authentication (optional)</span>
                </label>
                <input
                  id="mqttUsername"
                  type="text"
                  value={mqttUsername}
                  onChange={(e) => setMqttUsername(e.target.value)}
                  className="setting-input"
                />
              </div>
              <div className="setting-item">
                <label htmlFor="mqttPassword">
                  MQTT Password
                  <span className="setting-description">Password for MQTT authentication (optional)</span>
                </label>
                <input
                  id="mqttPassword"
                  type="password"
                  value={mqttPassword}
                  onChange={(e) => setMqttPassword(e.target.value)}
                  className="setting-input"
                />
              </div>
              <div className="setting-item">
                <label htmlFor="mqttRoot">
                  MQTT Root Topic
                  <span className="setting-description">Root topic for MQTT messages (e.g., "msh/US/MyRegion")</span>
                </label>
                <input
                  id="mqttRoot"
                  type="text"
                  value={mqttRoot}
                  onChange={(e) => setMqttRoot(e.target.value)}
                  className="setting-input"
                  placeholder="msh/US"
                />
              </div>
              <div className="setting-item">
                <label htmlFor="mqttEncryption" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="mqttEncryption"
                    type="checkbox"
                    checked={mqttEncryptionEnabled}
                    onChange={(e) => setMqttEncryptionEnabled(e.target.checked)}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>Encryption Enabled</div>
                    <span className="setting-description">Send encrypted packets to MQTT</span>
                  </div>
                </label>
              </div>
              <div className="setting-item">
                <label htmlFor="mqttJson" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="mqttJson"
                    type="checkbox"
                    checked={mqttJsonEnabled}
                    onChange={(e) => setMqttJsonEnabled(e.target.checked)}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>JSON Enabled</div>
                    <span className="setting-description">Send/receive JSON packets on MQTT</span>
                  </div>
                </label>
              </div>
            </>
          )}
          <button
            className="save-button"
            onClick={handleSaveMQTTConfig}
            disabled={isSaving}
          >
            {isSaving ? 'Saving...' : 'Save MQTT Config'}
          </button>
        </div>

        {/* NeighborInfo Configuration Section */}
        <div className="settings-section">
          <h3>Neighbor Info Module</h3>
          <div className="setting-item">
            <label htmlFor="neighborInfoEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="neighborInfoEnabled"
                type="checkbox"
                checked={neighborInfoEnabled}
                onChange={(e) => setNeighborInfoEnabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>Enable Neighbor Info</div>
                <span className="setting-description">Broadcast neighbor information to the mesh</span>
              </div>
            </label>
          </div>
          {neighborInfoEnabled && (
            <div className="setting-item">
              <label htmlFor="neighborInfoInterval">
                Update Interval (seconds)
                <span className="setting-description">How often to send neighbor info (minimum: 14400 = 4 hours)</span>
              </label>
              <input
                id="neighborInfoInterval"
                type="number"
                min="14400"
                max="86400"
                value={neighborInfoInterval}
                onChange={(e) => setNeighborInfoInterval(parseInt(e.target.value))}
                className="setting-input"
              />
            </div>
          )}
          <button
            className="save-button"
            onClick={handleSaveNeighborInfoConfig}
            disabled={isSaving}
          >
            {isSaving ? 'Saving...' : 'Save NeighborInfo Config'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfigurationTab;
