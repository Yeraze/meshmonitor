import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../services/api';
import { useToast } from './ToastContainer';
import { useAuth } from '../contexts/AuthContext';
import type { DeviceInfo, Channel } from '../types/device';
import { logger } from '../utils/logger';
import NodeIdentitySection from './configuration/NodeIdentitySection';
import DeviceConfigSection from './configuration/DeviceConfigSection';
import LoRaConfigSection from './configuration/LoRaConfigSection';
import PositionConfigSection from './configuration/PositionConfigSection';
import MQTTConfigSection from './configuration/MQTTConfigSection';
import NeighborInfoSection from './configuration/NeighborInfoSection';
import NetworkConfigSection from './configuration/NetworkConfigSection';
import PowerConfigSection from './configuration/PowerConfigSection';
import DisplayConfigSection from './configuration/DisplayConfigSection';
import TelemetryConfigSection from './configuration/TelemetryConfigSection';
import ExternalNotificationConfigSection from './configuration/ExternalNotificationConfigSection';
import StoreForwardConfigSection from './configuration/StoreForwardConfigSection';
import RangeTestConfigSection from './configuration/RangeTestConfigSection';
import CannedMessageConfigSection from './configuration/CannedMessageConfigSection';
import AudioConfigSection from './configuration/AudioConfigSection';
import RemoteHardwareConfigSection from './configuration/RemoteHardwareConfigSection';
import DetectionSensorConfigSection from './configuration/DetectionSensorConfigSection';
import PaxcounterConfigSection from './configuration/PaxcounterConfigSection';
import StatusMessageConfigSection from './configuration/StatusMessageConfigSection';
import TrafficManagementConfigSection from './configuration/TrafficManagementConfigSection';
import SerialConfigSection from './configuration/SerialConfigSection';
import AmbientLightingConfigSection from './configuration/AmbientLightingConfigSection';
import SecurityConfigSection from './configuration/SecurityConfigSection';
import ChannelsConfigSection from './configuration/ChannelsConfigSection';
import ChannelDatabaseSection from './configuration/ChannelDatabaseSection';
import GpioPinSummary from './configuration/GpioPinSummary';
import BackupManagementSection from './configuration/BackupManagementSection';
import { ImportConfigModal } from './configuration/ImportConfigModal';
import { ExportConfigModal } from './configuration/ExportConfigModal';
import { ROLE_MAP, PRESET_MAP, REGION_MAP } from './configuration/constants';
import SectionNav from './SectionNav';

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
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { authStatus } = useAuth();

  // Device Config State
  const [longName, setLongName] = useState('');
  const [shortName, setShortName] = useState('');
  const [isUnmessagable, setIsUnmessagable] = useState(false);
  const [role, setRole] = useState<number>(0);
  const [nodeInfoBroadcastSecs, setNodeInfoBroadcastSecs] = useState(3600);
  const [tzdef, setTzdef] = useState('');
  const [rebroadcastMode, setRebroadcastMode] = useState(0);
  const [doubleTapAsButtonPress, setDoubleTapAsButtonPress] = useState(false);
  const [disableTripleClick, setDisableTripleClick] = useState(false);
  const [ledHeartbeatDisabled, setLedHeartbeatDisabled] = useState(false);
  const [buzzerMode, setBuzzerMode] = useState(0);
  const [buttonGpio, setButtonGpio] = useState(0);
  const [buzzerGpio, setBuzzerGpio] = useState(0);

  // LoRa Config State
  const [usePreset, setUsePreset] = useState(true);
  const [modemPreset, setModemPreset] = useState<number>(0);
  const [bandwidth, setBandwidth] = useState<number>(250);
  const [spreadFactor, setSpreadFactor] = useState<number>(11);
  const [codingRate, setCodingRate] = useState<number>(8);
  const [frequencyOffset, setFrequencyOffset] = useState<number>(0);
  const [overrideFrequency, setOverrideFrequency] = useState<number>(0);
  const [region, setRegion] = useState<number>(0);
  const [hopLimit, setHopLimit] = useState<number>(3);
  const [txPower, setTxPower] = useState<number>(0);
  const [channelNum, setChannelNum] = useState<number>(0);
  const [sx126xRxBoostedGain, setSx126xRxBoostedGain] = useState<boolean>(false);
  const [ignoreMqtt, setIgnoreMqtt] = useState<boolean>(false);
  const [configOkToMqtt, setConfigOkToMqtt] = useState<boolean>(false);
  const [txEnabled, setTxEnabled] = useState<boolean>(true);
  const [overrideDutyCycle, setOverrideDutyCycle] = useState<boolean>(false);
  const [paFanDisabled, setPaFanDisabled] = useState<boolean>(false);

  // Position Config State
  const [positionBroadcastSecs, setPositionBroadcastSecs] = useState(900);
  const [positionSmartEnabled, setPositionSmartEnabled] = useState(true);
  const [fixedPosition, setFixedPosition] = useState(false);
  const [fixedLatitude, setFixedLatitude] = useState<number>(0);
  const [fixedLongitude, setFixedLongitude] = useState<number>(0);
  const [fixedAltitude, setFixedAltitude] = useState<number>(0);
  const [gpsUpdateInterval, setGpsUpdateInterval] = useState(0);
  const [gpsMode, setGpsMode] = useState(1);
  const [broadcastSmartMinimumDistance, setBroadcastSmartMinimumDistance] = useState(0);
  const [broadcastSmartMinimumIntervalSecs, setBroadcastSmartMinimumIntervalSecs] = useState(0);
  const [positionFlags, setPositionFlags] = useState(0);
  const [rxGpio, setRxGpio] = useState(0);
  const [txGpio, setTxGpio] = useState(0);
  const [gpsEnGpio, setGpsEnGpio] = useState(0);

  // MQTT Config State
  const [mqttEnabled, setMqttEnabled] = useState(false);
  const [mqttAddress, setMqttAddress] = useState('');
  const [mqttUsername, setMqttUsername] = useState('');
  const [mqttPassword, setMqttPassword] = useState('');
  const [mqttEncryptionEnabled, setMqttEncryptionEnabled] = useState(true);
  const [mqttJsonEnabled, setMqttJsonEnabled] = useState(false);
  const [mqttRoot, setMqttRoot] = useState('');
  const [mqttTlsEnabled, setMqttTlsEnabled] = useState(false);
  const [mqttProxyToClientEnabled, setMqttProxyToClientEnabled] = useState(false);
  const [mqttMapReportingEnabled, setMqttMapReportingEnabled] = useState(false);
  const [mqttMapPublishIntervalSecs, setMqttMapPublishIntervalSecs] = useState(0);
  const [mqttMapPositionPrecision, setMqttMapPositionPrecision] = useState(14);

  // NeighborInfo Config State
  const [neighborInfoEnabled, setNeighborInfoEnabled] = useState(false);
  const [neighborInfoInterval, setNeighborInfoInterval] = useState(14400);
  const [neighborInfoTransmitOverLora, setNeighborInfoTransmitOverLora] = useState(false);

  // Network Config State - store full config to avoid wiping fields when saving
  const [wifiEnabled, setWifiEnabled] = useState(false);
  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPsk, setWifiPsk] = useState('');
  const [ntpServer, setNtpServer] = useState('');
  const [addressMode, setAddressMode] = useState(0);
  const [ipv4Address, setIpv4Address] = useState('');
  const [ipv4Gateway, setIpv4Gateway] = useState('');
  const [ipv4Subnet, setIpv4Subnet] = useState('');
  const [ipv4Dns, setIpv4Dns] = useState('');
  const [fullNetworkConfig, setFullNetworkConfig] = useState<any>(null);

  // Power Config State
  const [isPowerSaving, setIsPowerSaving] = useState(false);
  const [onBatteryShutdownAfterSecs, setOnBatteryShutdownAfterSecs] = useState(0);
  const [adcMultiplierOverride, setAdcMultiplierOverride] = useState(0);
  const [waitBluetoothSecs, setWaitBluetoothSecs] = useState(60);
  const [sdsSecs, setSdsSecs] = useState(31536000);
  const [lsSecs, setLsSecs] = useState(300);
  const [minWakeSecs, setMinWakeSecs] = useState(10);
  const [deviceBatteryInaAddress, setDeviceBatteryInaAddress] = useState(0);

  // Display Config State
  const [screenOnSecs, setScreenOnSecs] = useState(60);
  const [autoScreenCarouselSecs, setAutoScreenCarouselSecs] = useState(0);
  const [flipScreen, setFlipScreen] = useState(false);
  const [displayUnits, setDisplayUnits] = useState(0);
  const [oled, setOled] = useState(0);
  const [displayMode, setDisplayMode] = useState(0);
  const [headingBold, setHeadingBold] = useState(false);
  const [wakeOnTapOrMotion, setWakeOnTapOrMotion] = useState(false);
  const [compassOrientation, setCompassOrientation] = useState(0);

  // Telemetry Config State
  const [deviceUpdateInterval, setDeviceUpdateInterval] = useState(900);
  const [deviceTelemetryEnabled, setDeviceTelemetryEnabled] = useState(false);
  const [environmentUpdateInterval, setEnvironmentUpdateInterval] = useState(900);
  const [environmentMeasurementEnabled, setEnvironmentMeasurementEnabled] = useState(false);
  const [environmentScreenEnabled, setEnvironmentScreenEnabled] = useState(false);
  const [environmentDisplayFahrenheit, setEnvironmentDisplayFahrenheit] = useState(false);
  const [airQualityEnabled, setAirQualityEnabled] = useState(false);
  const [airQualityInterval, setAirQualityInterval] = useState(900);
  const [powerMeasurementEnabled, setPowerMeasurementEnabled] = useState(false);
  const [powerUpdateInterval, setPowerUpdateInterval] = useState(900);
  const [powerScreenEnabled, setPowerScreenEnabled] = useState(false);
  const [healthMeasurementEnabled, setHealthMeasurementEnabled] = useState(false);
  const [healthUpdateInterval, setHealthUpdateInterval] = useState(900);
  const [healthScreenEnabled, setHealthScreenEnabled] = useState(false);
  const [telemetryConfigVersion, setTelemetryConfigVersion] = useState(0);

  // External Notification Config State
  const [extNotifEnabled, setExtNotifEnabled] = useState(false);
  const [extNotifOutputMs, setExtNotifOutputMs] = useState(1000);
  const [extNotifOutput, setExtNotifOutput] = useState(0);
  const [extNotifActive, setExtNotifActive] = useState(false);
  const [extNotifAlertMessage, setExtNotifAlertMessage] = useState(false);
  const [extNotifAlertMessageVibra, setExtNotifAlertMessageVibra] = useState(false);
  const [extNotifAlertMessageBuzzer, setExtNotifAlertMessageBuzzer] = useState(false);
  const [extNotifAlertBell, setExtNotifAlertBell] = useState(false);
  const [extNotifAlertBellVibra, setExtNotifAlertBellVibra] = useState(false);
  const [extNotifAlertBellBuzzer, setExtNotifAlertBellBuzzer] = useState(false);
  const [extNotifUsePwm, setExtNotifUsePwm] = useState(false);
  const [extNotifNagTimeout, setExtNotifNagTimeout] = useState(0);
  const [extNotifUseI2sAsBuzzer, setExtNotifUseI2sAsBuzzer] = useState(false);
  const [extNotifOutputVibra, setExtNotifOutputVibra] = useState(0);
  const [extNotifOutputBuzzer, setExtNotifOutputBuzzer] = useState(0);

  // Store & Forward Config State
  const [storeForwardEnabled, setStoreForwardEnabled] = useState(false);
  const [storeForwardHeartbeat, setStoreForwardHeartbeat] = useState(false);
  const [storeForwardRecords, setStoreForwardRecords] = useState(0);
  const [storeForwardHistoryReturnMax, setStoreForwardHistoryReturnMax] = useState(0);
  const [storeForwardHistoryReturnWindow, setStoreForwardHistoryReturnWindow] = useState(0);
  const [storeForwardIsServer, setStoreForwardIsServer] = useState(false);

  // Range Test Config State
  const [rangeTestEnabled, setRangeTestEnabled] = useState(false);
  const [rangeTestSender, setRangeTestSender] = useState(0);
  const [rangeTestSave, setRangeTestSave] = useState(false);

  // Canned Message Config State
  const [cannedMsgEnabled, setCannedMsgEnabled] = useState(false);
  const [cannedMsgRotary1Enabled, setCannedMsgRotary1Enabled] = useState(false);
  const [cannedMsgInputbrokerPinA, setCannedMsgInputbrokerPinA] = useState(0);
  const [cannedMsgInputbrokerPinB, setCannedMsgInputbrokerPinB] = useState(0);
  const [cannedMsgInputbrokerPinPress, setCannedMsgInputbrokerPinPress] = useState(0);
  const [cannedMsgInputbrokerEventCw, setCannedMsgInputbrokerEventCw] = useState(0);
  const [cannedMsgInputbrokerEventCcw, setCannedMsgInputbrokerEventCcw] = useState(0);
  const [cannedMsgInputbrokerEventPress, setCannedMsgInputbrokerEventPress] = useState(0);
  const [cannedMsgUpdown1Enabled, setCannedMsgUpdown1Enabled] = useState(false);
  const [cannedMsgSendBell, setCannedMsgSendBell] = useState(false);
  const [cannedMsgAllowInputSource, setCannedMsgAllowInputSource] = useState(0);

  // Audio Config State
  const [audioCodec2Enabled, setAudioCodec2Enabled] = useState(false);
  const [audioPttPin, setAudioPttPin] = useState(0);
  const [audioBitrate, setAudioBitrate] = useState(0);
  const [audioI2sWs, setAudioI2sWs] = useState(0);
  const [audioI2sSd, setAudioI2sSd] = useState(0);
  const [audioI2sDin, setAudioI2sDin] = useState(0);
  const [audioI2sSck, setAudioI2sSck] = useState(0);

  // Remote Hardware Config State
  const [remoteHardwareEnabled, setRemoteHardwareEnabled] = useState(false);
  const [remoteHardwareAllowUndefinedPinAccess, setRemoteHardwareAllowUndefinedPinAccess] = useState(false);

  // Detection Sensor Config State
  const [detectionSensorEnabled, setDetectionSensorEnabled] = useState(false);
  const [detectionSensorMinimumBroadcastSecs, setDetectionSensorMinimumBroadcastSecs] = useState(0);
  const [detectionSensorStateBroadcastSecs, setDetectionSensorStateBroadcastSecs] = useState(0);
  const [detectionSensorSendBell, setDetectionSensorSendBell] = useState(false);
  const [detectionSensorName, setDetectionSensorName] = useState('');
  const [detectionSensorMonitorPin, setDetectionSensorMonitorPin] = useState(0);
  const [detectionSensorDetectionTriggerType, setDetectionSensorDetectionTriggerType] = useState(0);
  const [detectionSensorUsePullup, setDetectionSensorUsePullup] = useState(false);

  // Paxcounter Config State
  const [paxcounterEnabled, setPaxcounterEnabled] = useState(false);
  const [paxcounterUpdateInterval, setPaxcounterUpdateInterval] = useState(0);
  const [paxcounterWifiThreshold, setPaxcounterWifiThreshold] = useState(-80);
  const [paxcounterBleThreshold, setPaxcounterBleThreshold] = useState(-80);

  // Status Message Config State
  const [statusMessageNodeStatus, setStatusMessageNodeStatus] = useState('');

  // Traffic Management Config State
  const [trafficManagementEnabled, setTrafficManagementEnabled] = useState(false);
  const [trafficManagementPositionDedupEnabled, setTrafficManagementPositionDedupEnabled] = useState(false);
  const [trafficManagementPositionDedupTimeSecs, setTrafficManagementPositionDedupTimeSecs] = useState(0);
  const [trafficManagementPositionDedupDistanceMeters, setTrafficManagementPositionDedupDistanceMeters] = useState(0);
  const [trafficManagementNodeinfoDirectResponseEnabled, setTrafficManagementNodeinfoDirectResponseEnabled] = useState(false);
  const [trafficManagementNodeinfoDirectResponseMyNodeOnly, setTrafficManagementNodeinfoDirectResponseMyNodeOnly] = useState(false);
  const [trafficManagementRateLimitEnabled, setTrafficManagementRateLimitEnabled] = useState(false);
  const [trafficManagementRateLimitMaxPerNode, setTrafficManagementRateLimitMaxPerNode] = useState(0);
  const [trafficManagementRateLimitWindowSecs, setTrafficManagementRateLimitWindowSecs] = useState(0);
  const [trafficManagementUnknownPacketDropEnabled, setTrafficManagementUnknownPacketDropEnabled] = useState(false);
  const [trafficManagementUnknownPacketGracePeriodSecs, setTrafficManagementUnknownPacketGracePeriodSecs] = useState(0);
  const [trafficManagementHopExhaustionEnabled, setTrafficManagementHopExhaustionEnabled] = useState(false);
  const [trafficManagementHopExhaustionMinHops, setTrafficManagementHopExhaustionMinHops] = useState(0);
  const [trafficManagementHopExhaustionMaxHops, setTrafficManagementHopExhaustionMaxHops] = useState(0);

  // Supported modules tracking (for unsupported firmware detection)
  const [supportedModules, setSupportedModules] = useState<{ statusmessage: boolean; trafficManagement: boolean } | null>(null);

  // Serial Config State
  const [serialEnabled, setSerialEnabled] = useState(false);
  const [serialEcho, setSerialEcho] = useState(false);
  const [serialRxd, setSerialRxd] = useState(0);
  const [serialTxd, setSerialTxd] = useState(0);
  const [serialBaud, setSerialBaud] = useState(0);
  const [serialTimeout, setSerialTimeout] = useState(0);
  const [serialMode, setSerialMode] = useState(0);
  const [serialOverrideConsoleSerialPort, setSerialOverrideConsoleSerialPort] = useState(false);

  // Ambient Lighting Config State
  const [ambientLedState, setAmbientLedState] = useState(false);
  const [ambientCurrent, setAmbientCurrent] = useState(10);
  const [ambientRed, setAmbientRed] = useState(0);
  const [ambientGreen, setAmbientGreen] = useState(0);
  const [ambientBlue, setAmbientBlue] = useState(0);

  // Security Config State
  const [securityPublicKey, setSecurityPublicKey] = useState('');
  const [securityPrivateKey, setSecurityPrivateKey] = useState('');
  const [securityAdminKeys, setSecurityAdminKeys] = useState<string[]>(['']);
  const [securityIsManaged, setSecurityIsManaged] = useState(false);
  const [securitySerialEnabled, setSecuritySerialEnabled] = useState(true);
  const [securityDebugLogApiEnabled, setSecurityDebugLogApiEnabled] = useState(false);
  const [securityAdminChannelEnabled, setSecurityAdminChannelEnabled] = useState(false);

  // UI State
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isReloading, setIsReloading] = useState(false);
  const [configChanges, setConfigChanges] = useState<{ field: string; oldValue: string; newValue: string }[]>([]);
  const [showChanges, setShowChanges] = useState(false);

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
          setIsUnmessagable(config.localNodeInfo.isUnmessagable || false);
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
          if (config.deviceConfig.device.tzdef !== undefined) {
            setTzdef(config.deviceConfig.device.tzdef);
          }
          if (config.deviceConfig.device.rebroadcastMode !== undefined) {
            setRebroadcastMode(config.deviceConfig.device.rebroadcastMode);
          }
          if (config.deviceConfig.device.doubleTapAsButtonPress !== undefined) {
            setDoubleTapAsButtonPress(config.deviceConfig.device.doubleTapAsButtonPress);
          }
          if (config.deviceConfig.device.disableTripleClick !== undefined) {
            setDisableTripleClick(config.deviceConfig.device.disableTripleClick);
          }
          if (config.deviceConfig.device.ledHeartbeatDisabled !== undefined) {
            setLedHeartbeatDisabled(config.deviceConfig.device.ledHeartbeatDisabled);
          }
          if (config.deviceConfig.device.buzzerMode !== undefined) {
            setBuzzerMode(config.deviceConfig.device.buzzerMode);
          }
          if (config.deviceConfig.device.buttonGpio !== undefined) {
            setButtonGpio(config.deviceConfig.device.buttonGpio);
          }
          if (config.deviceConfig.device.buzzerGpio !== undefined) {
            setBuzzerGpio(config.deviceConfig.device.buzzerGpio);
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
          if (config.deviceConfig.lora.bandwidth !== undefined) {
            setBandwidth(config.deviceConfig.lora.bandwidth);
          }
          if (config.deviceConfig.lora.spreadFactor !== undefined) {
            setSpreadFactor(config.deviceConfig.lora.spreadFactor);
          }
          if (config.deviceConfig.lora.codingRate !== undefined) {
            setCodingRate(config.deviceConfig.lora.codingRate);
          }
          if (config.deviceConfig.lora.frequencyOffset !== undefined) {
            setFrequencyOffset(config.deviceConfig.lora.frequencyOffset);
          }
          if (config.deviceConfig.lora.overrideFrequency !== undefined) {
            setOverrideFrequency(config.deviceConfig.lora.overrideFrequency);
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
          if (config.deviceConfig.lora.txPower !== undefined) {
            setTxPower(config.deviceConfig.lora.txPower);
          }
          if (config.deviceConfig.lora.channelNum !== undefined) {
            setChannelNum(config.deviceConfig.lora.channelNum);
          }
          if (config.deviceConfig.lora.sx126xRxBoostedGain !== undefined) {
            setSx126xRxBoostedGain(config.deviceConfig.lora.sx126xRxBoostedGain);
          }
          if (config.deviceConfig.lora.ignoreMqtt !== undefined) {
            setIgnoreMqtt(config.deviceConfig.lora.ignoreMqtt);
          }
          if (config.deviceConfig.lora.configOkToMqtt !== undefined) {
            setConfigOkToMqtt(config.deviceConfig.lora.configOkToMqtt);
          }
          if (config.deviceConfig.lora.txEnabled !== undefined) {
            setTxEnabled(config.deviceConfig.lora.txEnabled);
          }
          if (config.deviceConfig.lora.overrideDutyCycle !== undefined) {
            setOverrideDutyCycle(config.deviceConfig.lora.overrideDutyCycle);
          }
          if (config.deviceConfig.lora.paFanDisabled !== undefined) {
            setPaFanDisabled(config.deviceConfig.lora.paFanDisabled);
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
          if (config.deviceConfig.position.gpsUpdateInterval !== undefined) {
            setGpsUpdateInterval(config.deviceConfig.position.gpsUpdateInterval);
          }
          if (config.deviceConfig.position.gpsMode !== undefined) {
            setGpsMode(config.deviceConfig.position.gpsMode);
          }
          if (config.deviceConfig.position.broadcastSmartMinimumDistance !== undefined) {
            setBroadcastSmartMinimumDistance(config.deviceConfig.position.broadcastSmartMinimumDistance);
          }
          if (config.deviceConfig.position.broadcastSmartMinimumIntervalSecs !== undefined) {
            setBroadcastSmartMinimumIntervalSecs(config.deviceConfig.position.broadcastSmartMinimumIntervalSecs);
          }
          if (config.deviceConfig.position.positionFlags !== undefined) {
            setPositionFlags(config.deviceConfig.position.positionFlags);
          }
          if (config.deviceConfig.position.rxGpio !== undefined) {
            setRxGpio(config.deviceConfig.position.rxGpio);
          }
          if (config.deviceConfig.position.txGpio !== undefined) {
            setTxGpio(config.deviceConfig.position.txGpio);
          }
          if (config.deviceConfig.position.gpsEnGpio !== undefined) {
            setGpsEnGpio(config.deviceConfig.position.gpsEnGpio);
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
          setMqttTlsEnabled(config.moduleConfig.mqtt.tlsEnabled || false);
          setMqttProxyToClientEnabled(config.moduleConfig.mqtt.proxyToClientEnabled || false);
          setMqttMapReportingEnabled(config.moduleConfig.mqtt.mapReportingEnabled || false);
          setMqttMapPublishIntervalSecs(config.moduleConfig.mqtt.mapReportSettings?.publishIntervalSecs || 0);
          setMqttMapPositionPrecision(config.moduleConfig.mqtt.mapReportSettings?.positionPrecision ?? 14);
        }

        // Populate NeighborInfo config
        if (config.moduleConfig?.neighborInfo) {
          setNeighborInfoEnabled(config.moduleConfig.neighborInfo.enabled || false);
          setNeighborInfoInterval(config.moduleConfig.neighborInfo.updateInterval || 14400);
          setNeighborInfoTransmitOverLora(config.moduleConfig.neighborInfo.transmitOverLora || false);
        }

        // Populate Network config - store full config to preserve all fields when saving
        if (config.deviceConfig?.network) {
          setFullNetworkConfig(config.deviceConfig.network);
          setWifiEnabled(config.deviceConfig.network.wifiEnabled || false);
          setWifiSsid(config.deviceConfig.network.wifiSsid || '');
          setWifiPsk(config.deviceConfig.network.wifiPsk || '');
          setNtpServer(config.deviceConfig.network.ntpServer || '');
          setAddressMode(config.deviceConfig.network.addressMode ?? 0);
          // Static IP config
          if (config.deviceConfig.network.ipv4Config) {
            setIpv4Address(config.deviceConfig.network.ipv4Config.ip || '');
            setIpv4Gateway(config.deviceConfig.network.ipv4Config.gateway || '');
            setIpv4Subnet(config.deviceConfig.network.ipv4Config.subnet || '');
            setIpv4Dns(config.deviceConfig.network.ipv4Config.dns || '');
          }
        }

        // Populate Power config
        if (config.deviceConfig?.power) {
          setIsPowerSaving(config.deviceConfig.power.isPowerSaving || false);
          setOnBatteryShutdownAfterSecs(config.deviceConfig.power.onBatteryShutdownAfterSecs || 0);
          setAdcMultiplierOverride(config.deviceConfig.power.adcMultiplierOverride || 0);
          setWaitBluetoothSecs(config.deviceConfig.power.waitBluetoothSecs ?? 60);
          setSdsSecs(config.deviceConfig.power.sdsSecs ?? 31536000);
          setLsSecs(config.deviceConfig.power.lsSecs ?? 300);
          setMinWakeSecs(config.deviceConfig.power.minWakeSecs ?? 10);
          setDeviceBatteryInaAddress(config.deviceConfig.power.deviceBatteryInaAddress || 0);
        }

        // Populate Display config
        if (config.deviceConfig?.display) {
          setScreenOnSecs(config.deviceConfig.display.screenOnSecs ?? 60);
          setAutoScreenCarouselSecs(config.deviceConfig.display.autoScreenCarouselSecs || 0);
          setFlipScreen(config.deviceConfig.display.flipScreen || false);
          setDisplayUnits(config.deviceConfig.display.units ?? 0);
          setOled(config.deviceConfig.display.oled ?? 0);
          setDisplayMode(config.deviceConfig.display.displaymode ?? 0);
          setHeadingBold(config.deviceConfig.display.headingBold || false);
          setWakeOnTapOrMotion(config.deviceConfig.display.wakeOnTapOrMotion || false);
          setCompassOrientation(config.deviceConfig.display.compassOrientation ?? 0);
        }

        // Populate Telemetry config
        if (config.moduleConfig?.telemetry) {
          setDeviceUpdateInterval(config.moduleConfig.telemetry.deviceUpdateInterval ?? 900);
          setDeviceTelemetryEnabled(config.moduleConfig.telemetry.deviceTelemetryEnabled || false);
          setEnvironmentUpdateInterval(config.moduleConfig.telemetry.environmentUpdateInterval ?? 900);
          setEnvironmentMeasurementEnabled(config.moduleConfig.telemetry.environmentMeasurementEnabled || false);
          setEnvironmentScreenEnabled(config.moduleConfig.telemetry.environmentScreenEnabled || false);
          setEnvironmentDisplayFahrenheit(config.moduleConfig.telemetry.environmentDisplayFahrenheit || false);
          setAirQualityEnabled(config.moduleConfig.telemetry.airQualityEnabled || false);
          setAirQualityInterval(config.moduleConfig.telemetry.airQualityInterval ?? 900);
          setPowerMeasurementEnabled(config.moduleConfig.telemetry.powerMeasurementEnabled || false);
          setPowerUpdateInterval(config.moduleConfig.telemetry.powerUpdateInterval ?? 900);
          setPowerScreenEnabled(config.moduleConfig.telemetry.powerScreenEnabled || false);
          setHealthMeasurementEnabled(config.moduleConfig.telemetry.healthMeasurementEnabled || false);
          setHealthUpdateInterval(config.moduleConfig.telemetry.healthUpdateInterval ?? 900);
          setHealthScreenEnabled(config.moduleConfig.telemetry.healthScreenEnabled || false);
          // Increment version to signal config load to TelemetryConfigSection
          setTelemetryConfigVersion(v => v + 1);
        }

        // Populate External Notification config
        if (config.moduleConfig?.externalNotification) {
          const extNotif = config.moduleConfig.externalNotification;
          setExtNotifEnabled(extNotif.enabled || false);
          setExtNotifOutputMs(extNotif.outputMs ?? 1000);
          setExtNotifOutput(extNotif.output ?? 0);
          setExtNotifActive(extNotif.active || false);
          setExtNotifAlertMessage(extNotif.alertMessage || false);
          setExtNotifAlertMessageVibra(extNotif.alertMessageVibra || false);
          setExtNotifAlertMessageBuzzer(extNotif.alertMessageBuzzer || false);
          setExtNotifAlertBell(extNotif.alertBell || false);
          setExtNotifAlertBellVibra(extNotif.alertBellVibra || false);
          setExtNotifAlertBellBuzzer(extNotif.alertBellBuzzer || false);
          setExtNotifUsePwm(extNotif.usePwm || false);
          setExtNotifNagTimeout(extNotif.nagTimeout ?? 0);
          setExtNotifUseI2sAsBuzzer(extNotif.useI2sAsBuzzer || false);
          setExtNotifOutputVibra(extNotif.outputVibra ?? 0);
          setExtNotifOutputBuzzer(extNotif.outputBuzzer ?? 0);
        }

        // Populate Store & Forward config
        if (config.moduleConfig?.storeForward) {
          const sf = config.moduleConfig.storeForward;
          setStoreForwardEnabled(sf.enabled || false);
          setStoreForwardHeartbeat(sf.heartbeat || false);
          setStoreForwardRecords(sf.records ?? 0);
          setStoreForwardHistoryReturnMax(sf.historyReturnMax ?? 0);
          setStoreForwardHistoryReturnWindow(sf.historyReturnWindow ?? 0);
          setStoreForwardIsServer(sf.isServer || false);
        }

        // Populate Range Test config
        if (config.moduleConfig?.rangeTest) {
          const rt = config.moduleConfig.rangeTest;
          setRangeTestEnabled(rt.enabled || false);
          setRangeTestSender(rt.sender ?? 0);
          setRangeTestSave(rt.save || false);
        }

        // Populate Canned Message config
        if (config.moduleConfig?.cannedMessage) {
          const cm = config.moduleConfig.cannedMessage;
          setCannedMsgEnabled(cm.enabled || false);
          setCannedMsgRotary1Enabled(cm.rotary1Enabled || false);
          setCannedMsgInputbrokerPinA(cm.inputbrokerPinA ?? 0);
          setCannedMsgInputbrokerPinB(cm.inputbrokerPinB ?? 0);
          setCannedMsgInputbrokerPinPress(cm.inputbrokerPinPress ?? 0);
          setCannedMsgInputbrokerEventCw(cm.inputbrokerEventCw ?? 0);
          setCannedMsgInputbrokerEventCcw(cm.inputbrokerEventCcw ?? 0);
          setCannedMsgInputbrokerEventPress(cm.inputbrokerEventPress ?? 0);
          setCannedMsgUpdown1Enabled(cm.updown1Enabled || false);
          setCannedMsgSendBell(cm.sendBell || false);
          setCannedMsgAllowInputSource(cm.allowInputSource ?? 0);
        }

        // Populate Audio config
        if (config.moduleConfig?.audio) {
          const audio = config.moduleConfig.audio;
          setAudioCodec2Enabled(audio.codec2Enabled || false);
          setAudioPttPin(audio.pttPin ?? 0);
          setAudioBitrate(audio.bitrate ?? 0);
          setAudioI2sWs(audio.i2sWs ?? 0);
          setAudioI2sSd(audio.i2sSd ?? 0);
          setAudioI2sDin(audio.i2sDin ?? 0);
          setAudioI2sSck(audio.i2sSck ?? 0);
        }

        // Populate Remote Hardware config
        if (config.moduleConfig?.remoteHardware) {
          const rh = config.moduleConfig.remoteHardware;
          setRemoteHardwareEnabled(rh.enabled || false);
          setRemoteHardwareAllowUndefinedPinAccess(rh.allowUndefinedPinAccess || false);
        }

        // Populate Detection Sensor config
        if (config.moduleConfig?.detectionSensor) {
          const ds = config.moduleConfig.detectionSensor;
          setDetectionSensorEnabled(ds.enabled || false);
          setDetectionSensorMinimumBroadcastSecs(ds.minimumBroadcastSecs ?? 0);
          setDetectionSensorStateBroadcastSecs(ds.stateBroadcastSecs ?? 0);
          setDetectionSensorSendBell(ds.sendBell || false);
          setDetectionSensorName(ds.name || '');
          setDetectionSensorMonitorPin(ds.monitorPin ?? 0);
          setDetectionSensorDetectionTriggerType(ds.detectionTriggerType ?? 0);
          setDetectionSensorUsePullup(ds.usePullup || false);
        }

        // Populate Paxcounter config
        if (config.moduleConfig?.paxcounter) {
          const pax = config.moduleConfig.paxcounter;
          setPaxcounterEnabled(pax.enabled || false);
          setPaxcounterUpdateInterval(pax.paxcounterUpdateInterval ?? 0);
          setPaxcounterWifiThreshold(pax.wifiThreshold ?? -80);
          setPaxcounterBleThreshold(pax.bleThreshold ?? -80);
        }

        // Populate Status Message config
        if (config.moduleConfig?.statusmessage) {
          const sm = config.moduleConfig.statusmessage;
          setStatusMessageNodeStatus(sm.nodeStatus || '');
        }

        // Populate Traffic Management config
        if (config.moduleConfig?.trafficManagement) {
          const tm = config.moduleConfig.trafficManagement;
          setTrafficManagementEnabled(tm.enabled || false);
          setTrafficManagementPositionDedupEnabled(tm.positionDedupEnabled || false);
          setTrafficManagementPositionDedupTimeSecs(tm.positionDedupTimeSecs ?? 0);
          setTrafficManagementPositionDedupDistanceMeters(tm.positionDedupDistanceMeters ?? 0);
          setTrafficManagementNodeinfoDirectResponseEnabled(tm.nodeinfoDirectResponseEnabled || false);
          setTrafficManagementNodeinfoDirectResponseMyNodeOnly(tm.nodeinfoDirectResponseMyNodeOnly || false);
          setTrafficManagementRateLimitEnabled(tm.rateLimitEnabled || false);
          setTrafficManagementRateLimitMaxPerNode(tm.rateLimitMaxPerNode ?? 0);
          setTrafficManagementRateLimitWindowSecs(tm.rateLimitWindowSecs ?? 0);
          setTrafficManagementUnknownPacketDropEnabled(tm.unknownPacketDropEnabled || false);
          setTrafficManagementUnknownPacketGracePeriodSecs(tm.unknownPacketGracePeriodSecs ?? 0);
          setTrafficManagementHopExhaustionEnabled(tm.hopExhaustionEnabled || false);
          setTrafficManagementHopExhaustionMinHops(tm.hopExhaustionMinHops ?? 0);
          setTrafficManagementHopExhaustionMaxHops(tm.hopExhaustionMaxHops ?? 0);
        }

        // Store supported modules info
        if (config.supportedModules) {
          setSupportedModules(config.supportedModules);
        }

        // Populate Serial config
        if (config.moduleConfig?.serial) {
          const serial = config.moduleConfig.serial;
          setSerialEnabled(serial.enabled || false);
          setSerialEcho(serial.echo || false);
          setSerialRxd(serial.rxd ?? 0);
          setSerialTxd(serial.txd ?? 0);
          setSerialBaud(serial.baud ?? 0);
          setSerialTimeout(serial.timeout ?? 0);
          setSerialMode(serial.mode ?? 0);
          setSerialOverrideConsoleSerialPort(serial.overrideConsoleSerialPort || false);
        }

        // Populate Ambient Lighting config
        if (config.moduleConfig?.ambientLighting) {
          const al = config.moduleConfig.ambientLighting;
          setAmbientLedState(al.ledState || false);
          setAmbientCurrent(al.current ?? 10);
          setAmbientRed(al.red ?? 0);
          setAmbientGreen(al.green ?? 0);
          setAmbientBlue(al.blue ?? 0);
        }

        // Populate Security config
        if (config.deviceConfig?.security) {
          const sec = config.deviceConfig.security;
          // Admin keys come as base64 strings
          if (sec.adminKey && Array.isArray(sec.adminKey)) {
            setSecurityAdminKeys(sec.adminKey.length > 0 ? sec.adminKey : ['']);
          }
          setSecurityIsManaged(sec.isManaged || false);
          setSecuritySerialEnabled(sec.serialEnabled !== false); // Default to true
          setSecurityDebugLogApiEnabled(sec.debugLogApiEnabled || false);
          setSecurityAdminChannelEnabled(sec.adminChannelEnabled || false);
        }

        // Fetch security keys (public/private) separately
        try {
          const securityKeys = await apiService.getSecurityKeys();
          if (securityKeys.publicKey) {
            setSecurityPublicKey(securityKeys.publicKey);
          }
          if (securityKeys.privateKey) {
            setSecurityPrivateKey(securityKeys.privateKey);
          }
        } catch (keyError) {
          logger.warn('Could not fetch security keys:', keyError);
          // Non-fatal, continue loading
        }
      } catch (error) {
        logger.error('Error fetching configuration:', error);
        setStatusMessage(t('config.load_warning'));
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
        showToast(t('config.node_info_adjusted'), 'warning');
        setIsSaving(false);
        return;
      }

      await apiService.setDeviceConfig({
        role,
        nodeInfoBroadcastSecs: validNodeInfoBroadcastSecs,
        tzdef,
        rebroadcastMode,
        doubleTapAsButtonPress,
        disableTripleClick,
        ledHeartbeatDisabled,
        buzzerMode,
        buttonGpio,
        buzzerGpio
      });
      setStatusMessage(t('config.device_config_saved'));
      showToast(t('config.device_config_saved_toast'), 'success');
      // Device config changes don't require reboot
    } catch (error) {
      logger.error('Error saving device config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.device_config_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.device_config_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveNodeOwner = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setNodeOwner(longName, shortName, isUnmessagable);
      setStatusMessage(t('config.node_names_saved'));
      showToast(t('config.node_names_saved_toast'), 'success');
      // Node owner changes don't require reboot
    } catch (error) {
      logger.error('Error saving node owner:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.node_names_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.node_names_failed')}: ${errorMsg}`, 'error');
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
        showToast(t('config.hop_limit_adjusted'), 'warning');
        setIsSaving(false);
        return;
      }

      await apiService.setLoRaConfig({
        usePreset,
        modemPreset,
        bandwidth,
        spreadFactor,
        codingRate,
        frequencyOffset,
        overrideFrequency,
        region,
        hopLimit: validHopLimit,
        txPower,
        channelNum,
        sx126xRxBoostedGain,
        ignoreMqtt,
        configOkToMqtt,
        txEnabled,
        overrideDutyCycle,
        paFanDisabled
      });
      setStatusMessage(t('config.lora_saved'));
      showToast(t('config.lora_saved_toast'), 'success');
      onConfigChangeTriggeringReboot?.();
    } catch (error) {
      logger.error('Error saving LoRa config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.lora_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.lora_failed')}: ${errorMsg}`, 'error');
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
        showToast(t('config.position_interval_adjusted'), 'warning');
        setIsSaving(false);
        return;
      }

      // Validate lat/long ranges if fixed position is enabled
      if (fixedPosition) {
        if (fixedLatitude < -90 || fixedLatitude > 90) {
          showToast(t('config.latitude_range_error'), 'error');
          setIsSaving(false);
          return;
        }
        if (fixedLongitude < -180 || fixedLongitude > 180) {
          showToast(t('config.longitude_range_error'), 'error');
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
        altitude: fixedPosition ? fixedAltitude : undefined,
        gpsUpdateInterval,
        gpsMode,
        broadcastSmartMinimumDistance,
        broadcastSmartMinimumIntervalSecs,
        positionFlags,
        rxGpio,
        txGpio,
        gpsEnGpio
      });
      setStatusMessage(t('config.position_saved'));
      showToast(t('config.position_saved_toast'), 'success');
      // Position config changes don't require reboot
    } catch (error) {
      logger.error('Error saving position config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.position_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.position_failed')}: ${errorMsg}`, 'error');
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
        root: mqttRoot,
        tlsEnabled: mqttTlsEnabled,
        proxyToClientEnabled: mqttProxyToClientEnabled,
        mapReportingEnabled: mqttMapReportingEnabled,
        mapReportSettings: mqttMapReportingEnabled ? {
          publishIntervalSecs: mqttMapPublishIntervalSecs,
          positionPrecision: mqttMapPositionPrecision
        } : undefined
      });
      setStatusMessage(t('config.mqtt_saved'));
      showToast(t('config.mqtt_saved_toast'), 'success');
      // MQTT config changes don't require reboot
    } catch (error) {
      logger.error('Error saving MQTT config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.mqtt_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.mqtt_failed')}: ${errorMsg}`, 'error');
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
        showToast(t('config.neighbor_interval_adjusted'), 'warning');
      }

      await apiService.setNeighborInfoConfig({
        enabled: neighborInfoEnabled,
        updateInterval: validInterval,
        transmitOverLora: neighborInfoTransmitOverLora
      });
      setStatusMessage(t('config.neighbor_saved'));
      showToast(t('config.neighbor_saved_toast'), 'success');
      // NeighborInfo config changes don't require reboot
    } catch (error) {
      logger.error('Error saving NeighborInfo config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.neighbor_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.neighbor_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveNetworkConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      // Build the full network config with all updated fields
      const updatedConfig = {
        ...fullNetworkConfig,
        wifiEnabled,
        wifiSsid,
        wifiPsk,
        ntpServer,
        addressMode,
        // Static IP config - only include if using static address mode
        ipv4Config: addressMode === 1 ? {
          ip: ipv4Address,
          gateway: ipv4Gateway,
          subnet: ipv4Subnet,
          dns: ipv4Dns
        } : fullNetworkConfig?.ipv4Config
      };
      await apiService.setNetworkConfig(updatedConfig);
      // Update stored full config with the new values
      setFullNetworkConfig(updatedConfig);
      setStatusMessage(t('config.network_saved'));
      showToast(t('config.network_saved_toast'), 'success');
      onConfigChangeTriggeringReboot?.();
    } catch (error) {
      logger.error('Error saving Network config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.network_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.network_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSavePowerConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setPowerConfig({
        isPowerSaving,
        onBatteryShutdownAfterSecs,
        adcMultiplierOverride,
        waitBluetoothSecs,
        sdsSecs,
        lsSecs,
        minWakeSecs,
        deviceBatteryInaAddress
      });
      setStatusMessage(t('config.power_saved'));
      showToast(t('config.power_saved_toast'), 'success');
      // Power config changes don't require reboot
    } catch (error) {
      logger.error('Error saving Power config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.power_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.power_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveDisplayConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setDisplayConfig({
        screenOnSecs,
        autoScreenCarouselSecs,
        flipScreen,
        units: displayUnits,
        oled,
        displaymode: displayMode,
        headingBold,
        wakeOnTapOrMotion,
        compassOrientation
      });
      setStatusMessage(t('config.display_saved'));
      showToast(t('config.display_saved_toast'), 'success');
      // Display config changes don't require reboot
    } catch (error) {
      logger.error('Error saving Display config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.display_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.display_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveTelemetryConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setTelemetryConfig({
        deviceUpdateInterval,
        deviceTelemetryEnabled,
        environmentUpdateInterval,
        environmentMeasurementEnabled,
        environmentScreenEnabled,
        environmentDisplayFahrenheit,
        airQualityEnabled,
        airQualityInterval,
        powerMeasurementEnabled,
        powerUpdateInterval,
        powerScreenEnabled,
        healthMeasurementEnabled,
        healthUpdateInterval,
        healthScreenEnabled
      });
      setStatusMessage(t('config.telemetry_saved'));
      showToast(t('config.telemetry_saved_toast'), 'success');
      // Telemetry config changes don't require reboot
    } catch (error) {
      logger.error('Error saving Telemetry config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.telemetry_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.telemetry_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveExternalNotificationConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setModuleConfig('extnotif', {
        enabled: extNotifEnabled,
        outputMs: extNotifOutputMs,
        output: extNotifOutput,
        active: extNotifActive,
        alertMessage: extNotifAlertMessage,
        alertMessageVibra: extNotifAlertMessageVibra,
        alertMessageBuzzer: extNotifAlertMessageBuzzer,
        alertBell: extNotifAlertBell,
        alertBellVibra: extNotifAlertBellVibra,
        alertBellBuzzer: extNotifAlertBellBuzzer,
        usePwm: extNotifUsePwm,
        nagTimeout: extNotifNagTimeout,
        useI2sAsBuzzer: extNotifUseI2sAsBuzzer,
        outputVibra: extNotifOutputVibra,
        outputBuzzer: extNotifOutputBuzzer
      });
      setStatusMessage(t('config.extnotif_saved'));
      showToast(t('config.extnotif_saved_toast'), 'success');
    } catch (error) {
      logger.error('Error saving External Notification config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.extnotif_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.extnotif_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveStoreForwardConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setModuleConfig('storeforward', {
        enabled: storeForwardEnabled,
        heartbeat: storeForwardHeartbeat,
        records: storeForwardRecords,
        historyReturnMax: storeForwardHistoryReturnMax,
        historyReturnWindow: storeForwardHistoryReturnWindow,
        isServer: storeForwardIsServer
      });
      setStatusMessage(t('config.storeforward_saved'));
      showToast(t('config.storeforward_saved_toast'), 'success');
    } catch (error) {
      logger.error('Error saving Store & Forward config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.storeforward_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.storeforward_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveRangeTestConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setModuleConfig('rangetest', {
        enabled: rangeTestEnabled,
        sender: rangeTestSender,
        save: rangeTestSave
      });
      setStatusMessage(t('config.rangetest_saved'));
      showToast(t('config.rangetest_saved_toast'), 'success');
    } catch (error) {
      logger.error('Error saving Range Test config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.rangetest_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.rangetest_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveCannedMessageConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setModuleConfig('cannedmsg', {
        enabled: cannedMsgEnabled,
        rotary1Enabled: cannedMsgRotary1Enabled,
        inputbrokerPinA: cannedMsgInputbrokerPinA,
        inputbrokerPinB: cannedMsgInputbrokerPinB,
        inputbrokerPinPress: cannedMsgInputbrokerPinPress,
        inputbrokerEventCw: cannedMsgInputbrokerEventCw,
        inputbrokerEventCcw: cannedMsgInputbrokerEventCcw,
        inputbrokerEventPress: cannedMsgInputbrokerEventPress,
        updown1Enabled: cannedMsgUpdown1Enabled,
        sendBell: cannedMsgSendBell,
        allowInputSource: cannedMsgAllowInputSource
      });
      setStatusMessage(t('config.cannedmsg_saved'));
      showToast(t('config.cannedmsg_saved_toast'), 'success');
    } catch (error) {
      logger.error('Error saving Canned Message config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.cannedmsg_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.cannedmsg_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveAudioConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setModuleConfig('audio', {
        codec2Enabled: audioCodec2Enabled,
        pttPin: audioPttPin,
        bitrate: audioBitrate,
        i2sWs: audioI2sWs,
        i2sSd: audioI2sSd,
        i2sDin: audioI2sDin,
        i2sSck: audioI2sSck
      });
      setStatusMessage(t('config.audio_saved'));
      showToast(t('config.audio_saved_toast'), 'success');
    } catch (error) {
      logger.error('Error saving Audio config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.audio_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.audio_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveRemoteHardwareConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setModuleConfig('remotehardware', {
        enabled: remoteHardwareEnabled,
        allowUndefinedPinAccess: remoteHardwareAllowUndefinedPinAccess
      });
      setStatusMessage(t('config.remotehardware_saved'));
      showToast(t('config.remotehardware_saved_toast'), 'success');
    } catch (error) {
      logger.error('Error saving Remote Hardware config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.remotehardware_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.remotehardware_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveDetectionSensorConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setModuleConfig('detectionsensor', {
        enabled: detectionSensorEnabled,
        minimumBroadcastSecs: detectionSensorMinimumBroadcastSecs,
        stateBroadcastSecs: detectionSensorStateBroadcastSecs,
        sendBell: detectionSensorSendBell,
        name: detectionSensorName,
        monitorPin: detectionSensorMonitorPin,
        detectionTriggerType: detectionSensorDetectionTriggerType,
        usePullup: detectionSensorUsePullup
      });
      setStatusMessage(t('config.detectionsensor_saved'));
      showToast(t('config.detectionsensor_saved_toast'), 'success');
    } catch (error) {
      logger.error('Error saving Detection Sensor config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.detectionsensor_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.detectionsensor_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSavePaxcounterConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setModuleConfig('paxcounter', {
        enabled: paxcounterEnabled,
        paxcounterUpdateInterval: paxcounterUpdateInterval,
        wifiThreshold: paxcounterWifiThreshold,
        bleThreshold: paxcounterBleThreshold
      });
      setStatusMessage(t('config.paxcounter_saved'));
      showToast(t('config.paxcounter_saved_toast'), 'success');
    } catch (error) {
      logger.error('Error saving Paxcounter config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.paxcounter_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.paxcounter_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveStatusMessageConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setModuleConfig('statusmessage', {
        nodeStatus: statusMessageNodeStatus
      });
      setStatusMessage(t('config.statusmessage_saved', 'Status Message config saved'));
      showToast(t('config.statusmessage_saved_toast', 'Status Message config saved successfully'), 'success');
    } catch (error) {
      logger.error('Error saving Status Message config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.statusmessage_failed', 'Failed to save Status Message config');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.statusmessage_failed', 'Failed to save Status Message config')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveTrafficManagementConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setModuleConfig('trafficmanagement', {
        enabled: trafficManagementEnabled,
        positionDedupEnabled: trafficManagementPositionDedupEnabled,
        positionDedupTimeSecs: trafficManagementPositionDedupTimeSecs,
        positionDedupDistanceMeters: trafficManagementPositionDedupDistanceMeters,
        nodeinfoDirectResponseEnabled: trafficManagementNodeinfoDirectResponseEnabled,
        nodeinfoDirectResponseMyNodeOnly: trafficManagementNodeinfoDirectResponseMyNodeOnly,
        rateLimitEnabled: trafficManagementRateLimitEnabled,
        rateLimitMaxPerNode: trafficManagementRateLimitMaxPerNode,
        rateLimitWindowSecs: trafficManagementRateLimitWindowSecs,
        unknownPacketDropEnabled: trafficManagementUnknownPacketDropEnabled,
        unknownPacketGracePeriodSecs: trafficManagementUnknownPacketGracePeriodSecs,
        hopExhaustionEnabled: trafficManagementHopExhaustionEnabled,
        hopExhaustionMinHops: trafficManagementHopExhaustionMinHops,
        hopExhaustionMaxHops: trafficManagementHopExhaustionMaxHops
      });
      setStatusMessage(t('config.trafficmanagement_saved', 'Traffic Management config saved'));
      showToast(t('config.trafficmanagement_saved_toast', 'Traffic Management config saved successfully'), 'success');
    } catch (error) {
      logger.error('Error saving Traffic Management config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.trafficmanagement_failed', 'Failed to save Traffic Management config');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.trafficmanagement_failed', 'Failed to save Traffic Management config')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveSerialConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setModuleConfig('serial', {
        enabled: serialEnabled,
        echo: serialEcho,
        rxd: serialRxd,
        txd: serialTxd,
        baud: serialBaud,
        timeout: serialTimeout,
        mode: serialMode,
        overrideConsoleSerialPort: serialOverrideConsoleSerialPort
      });
      setStatusMessage(t('config.serial_saved'));
      showToast(t('config.serial_saved_toast'), 'success');
    } catch (error) {
      logger.error('Error saving Serial config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.serial_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.serial_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveAmbientLightingConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.setModuleConfig('ambientlighting', {
        ledState: ambientLedState,
        current: ambientCurrent,
        red: ambientRed,
        green: ambientGreen,
        blue: ambientBlue
      });
      setStatusMessage(t('config.ambientlighting_saved'));
      showToast(t('config.ambientlighting_saved_toast'), 'success');
    } catch (error) {
      logger.error('Error saving Ambient Lighting config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.ambientlighting_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.ambientlighting_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveSecurityConfig = async () => {
    setIsSaving(true);
    setStatusMessage('');
    try {
      // Filter out empty admin keys
      const validAdminKeys = securityAdminKeys.filter(key => key && key.trim().length > 0);

      await apiService.setSecurityConfig({
        adminKeys: validAdminKeys,
        isManaged: securityIsManaged,
        serialEnabled: securitySerialEnabled,
        debugLogApiEnabled: securityDebugLogApiEnabled,
        adminChannelEnabled: securityAdminChannelEnabled
      });
      setStatusMessage(t('config.security_saved'));
      showToast(t('config.security_saved_toast'), 'success');
      // Security config changes may require reboot for some settings
    } catch (error) {
      logger.error('Error saving Security config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.security_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.security_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRebootDevice = async () => {
    const confirmed = window.confirm(t('config.reboot_confirm'));

    if (!confirmed) {
      return;
    }

    setIsSaving(true);
    setStatusMessage('');
    try {
      if (onRebootDevice) {
        // Use the parent handler which manages connection status
        setStatusMessage(t('config.rebooting'));
        showToast(t('config.rebooting_toast'), 'info');
        const success = await onRebootDevice();
        if (success) {
          setStatusMessage(t('config.reboot_success'));
          showToast(t('config.reboot_success_toast'), 'success');
        } else {
          setStatusMessage(t('config.reboot_failed_reconnect'));
          showToast(t('config.reboot_failed_reconnect_toast'), 'warning');
        }
      } else {
        // Fallback to direct API call if handler not provided
        await apiService.rebootDevice(5);
        setStatusMessage(t('config.reboot_sent'));
        showToast(t('config.reboot_sent_toast'), 'success');
      }
    } catch (error) {
      logger.error('Error rebooting device:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.reboot_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.reboot_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handlePurgeNodeDb = async () => {
    const confirmed = window.confirm(t('config.purge_confirm'));

    if (!confirmed) {
      return;
    }

    setIsSaving(true);
    setStatusMessage('');
    try {
      await apiService.purgeNodeDb(0);
      setStatusMessage(t('config.purge_success'));
      showToast(t('config.purge_success'), 'success');
    } catch (error) {
      logger.error('Error purging node database:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.purge_failed');
      setStatusMessage(`Error: ${errorMsg}`);
      showToast(`${t('config.purge_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  // Helper to format value for display
  const formatValue = (value: any): string => {
    if (value === undefined || value === null) return 'N/A';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'number') return value.toString();
    return String(value);
  };

  // Reload configuration from device
  const handleReloadConfig = async () => {
    setIsReloading(true);
    setConfigChanges([]);
    setShowChanges(false);

    try {
      // Request fresh config from device
      await apiService.refreshNodes();

      // Wait a moment for device to respond
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Fetch updated config
      const config = await apiService.getCurrentConfig();

      const changes: { field: string; oldValue: string; newValue: string }[] = [];

      // Update state and track changes for Device Config
      if (config.deviceConfig?.device) {
        const device = config.deviceConfig.device;
        if (device.role !== undefined) {
          const newRole = typeof device.role === 'string' ? ROLE_MAP[device.role] || 0 : device.role;
          if (newRole !== role) {
            changes.push({ field: 'Device: Role', oldValue: formatValue(role), newValue: formatValue(newRole) });
          }
          setRole(newRole);
        }
        if (device.nodeInfoBroadcastSecs !== undefined && device.nodeInfoBroadcastSecs !== nodeInfoBroadcastSecs) {
          changes.push({ field: 'Device: Node Info Broadcast (s)', oldValue: formatValue(nodeInfoBroadcastSecs), newValue: formatValue(device.nodeInfoBroadcastSecs) });
          setNodeInfoBroadcastSecs(device.nodeInfoBroadcastSecs);
        }
        if (device.buzzerMode !== undefined && device.buzzerMode !== buzzerMode) {
          changes.push({ field: 'Device: Buzzer Mode', oldValue: formatValue(buzzerMode), newValue: formatValue(device.buzzerMode) });
          setBuzzerMode(device.buzzerMode);
        }
        if (device.ledHeartbeatDisabled !== undefined && device.ledHeartbeatDisabled !== ledHeartbeatDisabled) {
          changes.push({ field: 'Device: LED Heartbeat Disabled', oldValue: formatValue(ledHeartbeatDisabled), newValue: formatValue(device.ledHeartbeatDisabled) });
          setLedHeartbeatDisabled(device.ledHeartbeatDisabled);
        }
        if (device.rebroadcastMode !== undefined && device.rebroadcastMode !== rebroadcastMode) {
          changes.push({ field: 'Device: Rebroadcast Mode', oldValue: formatValue(rebroadcastMode), newValue: formatValue(device.rebroadcastMode) });
          setRebroadcastMode(device.rebroadcastMode);
        }
        if (device.tzdef !== undefined && device.tzdef !== tzdef) {
          changes.push({ field: 'Device: Timezone', oldValue: formatValue(tzdef), newValue: formatValue(device.tzdef) });
          setTzdef(device.tzdef);
        }
        if (device.doubleTapAsButtonPress !== undefined) setDoubleTapAsButtonPress(device.doubleTapAsButtonPress);
        if (device.disableTripleClick !== undefined) setDisableTripleClick(device.disableTripleClick);
        if (device.buttonGpio !== undefined) setButtonGpio(device.buttonGpio);
        if (device.buzzerGpio !== undefined) setBuzzerGpio(device.buzzerGpio);
      }

      // Update LoRa Config
      if (config.deviceConfig?.lora) {
        const lora = config.deviceConfig.lora;
        if (lora.usePreset !== undefined && lora.usePreset !== usePreset) {
          changes.push({ field: 'LoRa: Use Preset', oldValue: formatValue(usePreset), newValue: formatValue(lora.usePreset) });
          setUsePreset(lora.usePreset);
        }
        if (lora.modemPreset !== undefined) {
          const newPreset = typeof lora.modemPreset === 'string' ? PRESET_MAP[lora.modemPreset] || 0 : lora.modemPreset;
          if (newPreset !== modemPreset) {
            changes.push({ field: 'LoRa: Modem Preset', oldValue: formatValue(modemPreset), newValue: formatValue(newPreset) });
          }
          setModemPreset(newPreset);
        }
        if (lora.region !== undefined) {
          const newRegion = typeof lora.region === 'string' ? REGION_MAP[lora.region] || 0 : lora.region;
          if (newRegion !== region) {
            changes.push({ field: 'LoRa: Region', oldValue: formatValue(region), newValue: formatValue(newRegion) });
          }
          setRegion(newRegion);
        }
        if (lora.hopLimit !== undefined && lora.hopLimit !== hopLimit) {
          changes.push({ field: 'LoRa: Hop Limit', oldValue: formatValue(hopLimit), newValue: formatValue(lora.hopLimit) });
          setHopLimit(lora.hopLimit);
        }
        if (lora.txPower !== undefined && lora.txPower !== txPower) {
          changes.push({ field: 'LoRa: TX Power', oldValue: formatValue(txPower), newValue: formatValue(lora.txPower) });
          setTxPower(lora.txPower);
        }
        if (lora.txEnabled !== undefined && lora.txEnabled !== txEnabled) {
          changes.push({ field: 'LoRa: TX Enabled', oldValue: formatValue(txEnabled), newValue: formatValue(lora.txEnabled) });
          setTxEnabled(lora.txEnabled);
        }
        // Update remaining LoRa fields without change tracking
        if (lora.bandwidth !== undefined) setBandwidth(lora.bandwidth);
        if (lora.spreadFactor !== undefined) setSpreadFactor(lora.spreadFactor);
        if (lora.codingRate !== undefined) setCodingRate(lora.codingRate);
        if (lora.frequencyOffset !== undefined) setFrequencyOffset(lora.frequencyOffset);
        if (lora.overrideFrequency !== undefined) setOverrideFrequency(lora.overrideFrequency);
        if (lora.channelNum !== undefined) setChannelNum(lora.channelNum);
        if (lora.sx126xRxBoostedGain !== undefined) setSx126xRxBoostedGain(lora.sx126xRxBoostedGain);
        if (lora.ignoreMqtt !== undefined) setIgnoreMqtt(lora.ignoreMqtt);
        if (lora.configOkToMqtt !== undefined) setConfigOkToMqtt(lora.configOkToMqtt);
        if (lora.overrideDutyCycle !== undefined) setOverrideDutyCycle(lora.overrideDutyCycle);
        if (lora.paFanDisabled !== undefined) setPaFanDisabled(lora.paFanDisabled);
      }

      // Update Position Config
      if (config.deviceConfig?.position) {
        const pos = config.deviceConfig.position;
        if (pos.positionBroadcastSecs !== undefined && pos.positionBroadcastSecs !== positionBroadcastSecs) {
          changes.push({ field: 'Position: Broadcast Interval (s)', oldValue: formatValue(positionBroadcastSecs), newValue: formatValue(pos.positionBroadcastSecs) });
          setPositionBroadcastSecs(pos.positionBroadcastSecs);
        }
        if (pos.positionBroadcastSmartEnabled !== undefined && pos.positionBroadcastSmartEnabled !== positionSmartEnabled) {
          changes.push({ field: 'Position: Smart Enabled', oldValue: formatValue(positionSmartEnabled), newValue: formatValue(pos.positionBroadcastSmartEnabled) });
          setPositionSmartEnabled(pos.positionBroadcastSmartEnabled);
        }
        if (pos.fixedPosition !== undefined && pos.fixedPosition !== fixedPosition) {
          changes.push({ field: 'Position: Fixed Position', oldValue: formatValue(fixedPosition), newValue: formatValue(pos.fixedPosition) });
          setFixedPosition(pos.fixedPosition);
        }
        if (pos.gpsMode !== undefined && pos.gpsMode !== gpsMode) {
          changes.push({ field: 'Position: GPS Mode', oldValue: formatValue(gpsMode), newValue: formatValue(pos.gpsMode) });
          setGpsMode(pos.gpsMode);
        }
        // Update remaining position fields
        if (pos.gpsUpdateInterval !== undefined) setGpsUpdateInterval(pos.gpsUpdateInterval);
        if (pos.broadcastSmartMinimumDistance !== undefined) setBroadcastSmartMinimumDistance(pos.broadcastSmartMinimumDistance);
        if (pos.broadcastSmartMinimumIntervalSecs !== undefined) setBroadcastSmartMinimumIntervalSecs(pos.broadcastSmartMinimumIntervalSecs);
        if (pos.positionFlags !== undefined) setPositionFlags(pos.positionFlags);
        if (pos.rxGpio !== undefined) setRxGpio(pos.rxGpio);
        if (pos.txGpio !== undefined) setTxGpio(pos.txGpio);
        if (pos.gpsEnGpio !== undefined) setGpsEnGpio(pos.gpsEnGpio);
      }

      // Update MQTT Config
      if (config.moduleConfig?.mqtt) {
        const mqtt = config.moduleConfig.mqtt;
        if (mqtt.enabled !== undefined && mqtt.enabled !== mqttEnabled) {
          changes.push({ field: 'MQTT: Enabled', oldValue: formatValue(mqttEnabled), newValue: formatValue(mqtt.enabled) });
          setMqttEnabled(mqtt.enabled);
        }
        if (mqtt.address !== undefined && mqtt.address !== mqttAddress) {
          changes.push({ field: 'MQTT: Address', oldValue: formatValue(mqttAddress), newValue: formatValue(mqtt.address) });
          setMqttAddress(mqtt.address);
        }
        if (mqtt.encryptionEnabled !== undefined && mqtt.encryptionEnabled !== mqttEncryptionEnabled) {
          changes.push({ field: 'MQTT: Encryption Enabled', oldValue: formatValue(mqttEncryptionEnabled), newValue: formatValue(mqtt.encryptionEnabled) });
          setMqttEncryptionEnabled(mqtt.encryptionEnabled);
        }
        if (mqtt.tlsEnabled !== undefined && mqtt.tlsEnabled !== mqttTlsEnabled) {
          changes.push({ field: 'MQTT: TLS Enabled', oldValue: formatValue(mqttTlsEnabled), newValue: formatValue(mqtt.tlsEnabled) });
          setMqttTlsEnabled(mqtt.tlsEnabled);
        }
        // Update remaining MQTT fields
        if (mqtt.username !== undefined) setMqttUsername(mqtt.username);
        if (mqtt.password !== undefined) setMqttPassword(mqtt.password);
        if (mqtt.jsonEnabled !== undefined) setMqttJsonEnabled(mqtt.jsonEnabled);
        if (mqtt.root !== undefined) setMqttRoot(mqtt.root);
        if (mqtt.proxyToClientEnabled !== undefined) setMqttProxyToClientEnabled(mqtt.proxyToClientEnabled);
        if (mqtt.mapReportingEnabled !== undefined) setMqttMapReportingEnabled(mqtt.mapReportingEnabled);
        if (mqtt.mapReportSettings?.publishIntervalSecs !== undefined) setMqttMapPublishIntervalSecs(mqtt.mapReportSettings.publishIntervalSecs);
        if (mqtt.mapReportSettings?.positionPrecision !== undefined) setMqttMapPositionPrecision(mqtt.mapReportSettings.positionPrecision);
      }

      // Update Network Config
      if (config.deviceConfig?.network) {
        const net = config.deviceConfig.network;
        if (net.wifiEnabled !== undefined && net.wifiEnabled !== wifiEnabled) {
          changes.push({ field: 'Network: WiFi Enabled', oldValue: formatValue(wifiEnabled), newValue: formatValue(net.wifiEnabled) });
          setWifiEnabled(net.wifiEnabled);
        }
        if (net.wifiSsid !== undefined && net.wifiSsid !== wifiSsid) {
          changes.push({ field: 'Network: WiFi SSID', oldValue: formatValue(wifiSsid), newValue: formatValue(net.wifiSsid) });
          setWifiSsid(net.wifiSsid);
        }
        if (net.addressMode !== undefined && net.addressMode !== addressMode) {
          changes.push({ field: 'Network: Address Mode', oldValue: formatValue(addressMode), newValue: formatValue(net.addressMode) });
          setAddressMode(net.addressMode);
        }
        // Update remaining network fields
        if (net.wifiPsk !== undefined) setWifiPsk(net.wifiPsk);
        if (net.ntpServer !== undefined) setNtpServer(net.ntpServer);
        if (net.ipv4Config) {
          if (net.ipv4Config.ip !== undefined) setIpv4Address(net.ipv4Config.ip);
          if (net.ipv4Config.gateway !== undefined) setIpv4Gateway(net.ipv4Config.gateway);
          if (net.ipv4Config.subnet !== undefined) setIpv4Subnet(net.ipv4Config.subnet);
          if (net.ipv4Config.dns !== undefined) setIpv4Dns(net.ipv4Config.dns);
        }
        setFullNetworkConfig(net);
      }

      // Update Power Config
      if (config.deviceConfig?.power) {
        const pwr = config.deviceConfig.power;
        if (pwr.isPowerSaving !== undefined && pwr.isPowerSaving !== isPowerSaving) {
          changes.push({ field: 'Power: Power Saving', oldValue: formatValue(isPowerSaving), newValue: formatValue(pwr.isPowerSaving) });
          setIsPowerSaving(pwr.isPowerSaving);
        }
        // Update remaining power fields
        if (pwr.onBatteryShutdownAfterSecs !== undefined) setOnBatteryShutdownAfterSecs(pwr.onBatteryShutdownAfterSecs);
        if (pwr.adcMultiplierOverride !== undefined) setAdcMultiplierOverride(pwr.adcMultiplierOverride);
        if (pwr.waitBluetoothSecs !== undefined) setWaitBluetoothSecs(pwr.waitBluetoothSecs);
        if (pwr.sdsSecs !== undefined) setSdsSecs(pwr.sdsSecs);
        if (pwr.lsSecs !== undefined) setLsSecs(pwr.lsSecs);
        if (pwr.minWakeSecs !== undefined) setMinWakeSecs(pwr.minWakeSecs);
        if (pwr.deviceBatteryInaAddress !== undefined) setDeviceBatteryInaAddress(pwr.deviceBatteryInaAddress);
      }

      // Update Display Config
      if (config.deviceConfig?.display) {
        const disp = config.deviceConfig.display;
        if (disp.screenOnSecs !== undefined && disp.screenOnSecs !== screenOnSecs) {
          changes.push({ field: 'Display: Screen On (s)', oldValue: formatValue(screenOnSecs), newValue: formatValue(disp.screenOnSecs) });
          setScreenOnSecs(disp.screenOnSecs);
        }
        if (disp.flipScreen !== undefined && disp.flipScreen !== flipScreen) {
          changes.push({ field: 'Display: Flip Screen', oldValue: formatValue(flipScreen), newValue: formatValue(disp.flipScreen) });
          setFlipScreen(disp.flipScreen);
        }
        if (disp.units !== undefined && disp.units !== displayUnits) {
          changes.push({ field: 'Display: Units', oldValue: formatValue(displayUnits), newValue: formatValue(disp.units) });
          setDisplayUnits(disp.units);
        }
        // Update remaining display fields
        if (disp.autoScreenCarouselSecs !== undefined) setAutoScreenCarouselSecs(disp.autoScreenCarouselSecs);
        if (disp.oled !== undefined) setOled(disp.oled);
        if (disp.displaymode !== undefined) setDisplayMode(disp.displaymode);
        if (disp.headingBold !== undefined) setHeadingBold(disp.headingBold);
        if (disp.wakeOnTapOrMotion !== undefined) setWakeOnTapOrMotion(disp.wakeOnTapOrMotion);
        if (disp.compassOrientation !== undefined) setCompassOrientation(disp.compassOrientation);
      }

      // Update NeighborInfo Config
      if (config.moduleConfig?.neighborInfo) {
        const ni = config.moduleConfig.neighborInfo;
        if (ni.enabled !== undefined && ni.enabled !== neighborInfoEnabled) {
          changes.push({ field: 'Neighbor Info: Enabled', oldValue: formatValue(neighborInfoEnabled), newValue: formatValue(ni.enabled) });
          setNeighborInfoEnabled(ni.enabled);
        }
        if (ni.updateInterval !== undefined && ni.updateInterval !== neighborInfoInterval) {
          changes.push({ field: 'Neighbor Info: Interval (s)', oldValue: formatValue(neighborInfoInterval), newValue: formatValue(ni.updateInterval) });
          setNeighborInfoInterval(ni.updateInterval);
        }
        if (ni.transmitOverLora !== undefined) setNeighborInfoTransmitOverLora(ni.transmitOverLora);
      }

      // Update Telemetry Config
      if (config.moduleConfig?.telemetry) {
        const tel = config.moduleConfig.telemetry;
        if (tel.deviceUpdateInterval !== undefined) setDeviceUpdateInterval(tel.deviceUpdateInterval);
        if (tel.deviceTelemetryEnabled !== undefined) setDeviceTelemetryEnabled(tel.deviceTelemetryEnabled);
        if (tel.environmentUpdateInterval !== undefined) setEnvironmentUpdateInterval(tel.environmentUpdateInterval);
        if (tel.environmentMeasurementEnabled !== undefined) setEnvironmentMeasurementEnabled(tel.environmentMeasurementEnabled);
        if (tel.environmentScreenEnabled !== undefined) setEnvironmentScreenEnabled(tel.environmentScreenEnabled);
        if (tel.environmentDisplayFahrenheit !== undefined) setEnvironmentDisplayFahrenheit(tel.environmentDisplayFahrenheit);
        if (tel.airQualityEnabled !== undefined) setAirQualityEnabled(tel.airQualityEnabled);
        if (tel.airQualityInterval !== undefined) setAirQualityInterval(tel.airQualityInterval);
        if (tel.powerMeasurementEnabled !== undefined) setPowerMeasurementEnabled(tel.powerMeasurementEnabled);
        if (tel.powerUpdateInterval !== undefined) setPowerUpdateInterval(tel.powerUpdateInterval);
        if (tel.powerScreenEnabled !== undefined) setPowerScreenEnabled(tel.powerScreenEnabled);
        if (tel.healthMeasurementEnabled !== undefined) setHealthMeasurementEnabled(tel.healthMeasurementEnabled);
        if (tel.healthUpdateInterval !== undefined) setHealthUpdateInterval(tel.healthUpdateInterval);
        if (tel.healthScreenEnabled !== undefined) setHealthScreenEnabled(tel.healthScreenEnabled);
        // Increment version to signal config update to TelemetryConfigSection
        setTelemetryConfigVersion(v => v + 1);
      }

      // Update Node Identity
      if (config.localNodeInfo) {
        if (config.localNodeInfo.longName !== undefined) setLongName(config.localNodeInfo.longName);
        if (config.localNodeInfo.shortName !== undefined) setShortName(config.localNodeInfo.shortName);
        if (config.localNodeInfo.isUnmessagable !== undefined) setIsUnmessagable(config.localNodeInfo.isUnmessagable);
      }

      setConfigChanges(changes);
      if (changes.length > 0) {
        setShowChanges(true);
        showToast(t('config.reload_changes_detected', { count: changes.length }), 'info');
      } else {
        showToast(t('config.reload_no_changes'), 'success');
      }

      logger.info(`Config reloaded. ${changes.length} changes detected.`);
    } catch (error) {
      logger.error('Error reloading config:', error);
      const errorMsg = error instanceof Error ? error.message : t('config.reload_failed');
      showToast(`${t('config.reload_failed')}: ${errorMsg}`, 'error');
    } finally {
      setIsReloading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="tab-content">
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <p>{t('config.loading')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tab-content">
      <SectionNav items={[
        { id: 'config-danger', label: t('config.warning_title', 'Warning') },
        { id: 'config-import-export', label: t('config.import_export_title', 'Import/Export') },
        { id: 'config-node-identity', label: t('config.node_identity', 'Node Identity') },
        { id: 'config-device', label: t('config.device_config', 'Device') },
        { id: 'config-lora', label: t('config.lora_config', 'LoRa') },
        { id: 'config-position', label: t('config.position_config', 'Position') },
        { id: 'config-power', label: t('config.power_config', 'Power') },
        { id: 'config-display', label: t('config.display_config', 'Display') },
        { id: 'config-telemetry', label: t('config.telemetry_config', 'Telemetry') },
        { id: 'config-mqtt', label: t('config.mqtt_config', 'MQTT') },
        { id: 'config-neighbor', label: t('config.neighbor_info', 'Neighbor Info') },
        { id: 'config-network', label: t('config.network_config', 'Network') },
        { id: 'config-extnotif', label: t('extnotif_config.title', 'External Notification') },
        { id: 'config-storeforward', label: t('storeforward_config.title', 'Store & Forward') },
        { id: 'config-rangetest', label: t('rangetest_config.title', 'Range Test') },
        { id: 'config-cannedmsg', label: t('cannedmsg_config.title', 'Canned Messages') },
        { id: 'config-audio', label: t('audio_config.title', 'Audio') },
        { id: 'config-remotehardware', label: t('remotehardware_config.title', 'Remote Hardware') },
        { id: 'config-detectionsensor', label: t('detectionsensor_config.title', 'Detection Sensor') },
        { id: 'config-paxcounter', label: t('paxcounter_config.title', 'Paxcounter') },
        { id: 'config-statusmessage', label: t('statusmessage_config.title', 'Status Message') },
        { id: 'config-trafficmanagement', label: t('trafficmanagement_config.title', 'Traffic Management') },
        { id: 'config-serial', label: t('serial_config.title', 'Serial') },
        { id: 'config-ambientlighting', label: t('ambientlighting_config.title', 'Ambient Lighting') },
        { id: 'config-security', label: t('security_config.title', 'Security') },
        { id: 'config-channels', label: t('config.channels', 'Channels') },
        { id: 'config-channel-database', label: t('channel_database.title', 'Channel Database') },
        { id: 'config-backup', label: t('config.backup_management', 'Backup') },
      ]} />

      {/* Two-column layout: main content on left, GPIO summary on right */}
      <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start' }}>
        {/* Main content column */}
        <div style={{ flex: 1, minWidth: 0 }}>

      <div id="config-danger" className="settings-section danger-zone" style={{ marginBottom: '2rem' }}>
        <h2 style={{ color: '#ff4444', marginTop: 0 }}>⚠️ {t('config.warning_title')}</h2>
        <p style={{ fontSize: '1.1rem', fontWeight: 'bold' }}>
          {t('config.warning_text')}
        </p>
        <p>
          {t('config.warning_description')}
        </p>
        <div style={{ marginTop: '1.5rem', display: 'flex', gap: '1rem' }}>
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
            🔄 {t('config.reboot_device')}
          </button>
          <button
            onClick={handlePurgeNodeDb}
            disabled={isSaving}
            style={{
              backgroundColor: '#d32f2f',
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
            🗑️ {t('config.purge_node_db')}
          </button>
          <button
            onClick={handleReloadConfig}
            disabled={isReloading}
            style={{
              backgroundColor: 'var(--ctp-teal)',
              color: '#fff',
              padding: '0.75rem 1.5rem',
              border: 'none',
              borderRadius: '4px',
              cursor: isReloading ? 'not-allowed' : 'pointer',
              fontSize: '1rem',
              fontWeight: 'bold',
              opacity: isReloading ? 0.6 : 1
            }}
          >
            {isReloading ? (
              <>
                <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>🔄</span>
                {' '}{t('config.reloading')}
              </>
            ) : (
              <>🔃 {t('config.reload_config')}</>
            )}
          </button>
        </div>
        {/* Config Changes Display */}
        {configChanges.length > 0 && (
          <div style={{ marginTop: '1rem' }}>
            <button
              onClick={() => setShowChanges(!showChanges)}
              style={{
                background: 'transparent',
                border: '1px solid var(--ctp-surface2)',
                color: 'var(--ctp-text)',
                padding: '0.5rem 1rem',
                borderRadius: '4px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}
            >
              <span>{showChanges ? '▼' : '▶'}</span>
              {t('config.changes_detected', { count: configChanges.length })}
            </button>
            {showChanges && (
              <div style={{
                marginTop: '0.5rem',
                padding: '1rem',
                backgroundColor: 'var(--ctp-surface0)',
                borderRadius: '4px',
                border: '1px solid var(--ctp-surface2)'
              }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--ctp-surface2)' }}>
                      <th style={{ textAlign: 'left', padding: '0.5rem', color: 'var(--ctp-subtext0)' }}>{t('config.field')}</th>
                      <th style={{ textAlign: 'left', padding: '0.5rem', color: 'var(--ctp-subtext0)' }}>{t('config.old_value')}</th>
                      <th style={{ textAlign: 'left', padding: '0.5rem', color: 'var(--ctp-subtext0)' }}>{t('config.new_value')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {configChanges.map((change, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid var(--ctp-surface1)' }}>
                        <td style={{ padding: '0.5rem' }}>{change.field}</td>
                        <td style={{ padding: '0.5rem', color: 'var(--ctp-red)' }}>{change.oldValue}</td>
                        <td style={{ padding: '0.5rem', color: 'var(--ctp-green)' }}>{change.newValue}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Import/Export Configuration Section */}
      <div id="config-import-export" className="settings-section" style={{ marginBottom: '2rem' }}>
        <h3>{t('config.import_export_title')}</h3>
        <p style={{ color: 'var(--ctp-subtext0)', marginBottom: '1rem' }}>
          {t('config.import_export_description')}
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
            📥 {t('config.import_config')}
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
            📤 {t('config.export_config')}
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
        <div id="config-node-identity">
          <NodeIdentitySection
            longName={longName}
            shortName={shortName}
            isUnmessagable={isUnmessagable}
            setLongName={setLongName}
            setShortName={setShortName}
            setIsUnmessagable={setIsUnmessagable}
            isSaving={isSaving}
            onSave={handleSaveNodeOwner}
          />
        </div>

        <div id="config-device">
          <DeviceConfigSection
            role={role}
            setRole={setRole}
            nodeInfoBroadcastSecs={nodeInfoBroadcastSecs}
            setNodeInfoBroadcastSecs={setNodeInfoBroadcastSecs}
            tzdef={tzdef}
            setTzdef={setTzdef}
            rebroadcastMode={rebroadcastMode}
            setRebroadcastMode={setRebroadcastMode}
            doubleTapAsButtonPress={doubleTapAsButtonPress}
            setDoubleTapAsButtonPress={setDoubleTapAsButtonPress}
            disableTripleClick={disableTripleClick}
            setDisableTripleClick={setDisableTripleClick}
            ledHeartbeatDisabled={ledHeartbeatDisabled}
            setLedHeartbeatDisabled={setLedHeartbeatDisabled}
            buzzerMode={buzzerMode}
            setBuzzerMode={setBuzzerMode}
            buttonGpio={buttonGpio}
            setButtonGpio={setButtonGpio}
            buzzerGpio={buzzerGpio}
            setBuzzerGpio={setBuzzerGpio}
            isSaving={isSaving}
            onSave={handleSaveDeviceConfig}
          />
        </div>

        <div id="config-lora">
          <LoRaConfigSection
            usePreset={usePreset}
            setUsePreset={setUsePreset}
            modemPreset={modemPreset}
            setModemPreset={setModemPreset}
            bandwidth={bandwidth}
            setBandwidth={setBandwidth}
            spreadFactor={spreadFactor}
            setSpreadFactor={setSpreadFactor}
            codingRate={codingRate}
            setCodingRate={setCodingRate}
            frequencyOffset={frequencyOffset}
            setFrequencyOffset={setFrequencyOffset}
            overrideFrequency={overrideFrequency}
            setOverrideFrequency={setOverrideFrequency}
            region={region}
            setRegion={setRegion}
            hopLimit={hopLimit}
            setHopLimit={setHopLimit}
            txPower={txPower}
            setTxPower={setTxPower}
            channelNum={channelNum}
            setChannelNum={setChannelNum}
            sx126xRxBoostedGain={sx126xRxBoostedGain}
            setSx126xRxBoostedGain={setSx126xRxBoostedGain}
            ignoreMqtt={ignoreMqtt}
            setIgnoreMqtt={setIgnoreMqtt}
            configOkToMqtt={configOkToMqtt}
            setConfigOkToMqtt={setConfigOkToMqtt}
            txEnabled={txEnabled}
            setTxEnabled={setTxEnabled}
            overrideDutyCycle={overrideDutyCycle}
            setOverrideDutyCycle={setOverrideDutyCycle}
            paFanDisabled={paFanDisabled}
            setPaFanDisabled={setPaFanDisabled}
            isSaving={isSaving}
            onSave={handleSaveLoRaConfig}
          />
        </div>

        <div id="config-position">
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
            gpsUpdateInterval={gpsUpdateInterval}
            setGpsUpdateInterval={setGpsUpdateInterval}
            gpsMode={gpsMode}
            setGpsMode={setGpsMode}
            broadcastSmartMinimumDistance={broadcastSmartMinimumDistance}
            setBroadcastSmartMinimumDistance={setBroadcastSmartMinimumDistance}
            broadcastSmartMinimumIntervalSecs={broadcastSmartMinimumIntervalSecs}
            setBroadcastSmartMinimumIntervalSecs={setBroadcastSmartMinimumIntervalSecs}
            positionFlags={positionFlags}
            setPositionFlags={setPositionFlags}
            rxGpio={rxGpio}
            setRxGpio={setRxGpio}
            txGpio={txGpio}
            setTxGpio={setTxGpio}
            gpsEnGpio={gpsEnGpio}
            setGpsEnGpio={setGpsEnGpio}
            isSaving={isSaving}
            onSave={handleSavePositionConfig}
          />
        </div>

        <div id="config-power">
          <PowerConfigSection
            isPowerSaving={isPowerSaving}
            setIsPowerSaving={setIsPowerSaving}
            onBatteryShutdownAfterSecs={onBatteryShutdownAfterSecs}
            setOnBatteryShutdownAfterSecs={setOnBatteryShutdownAfterSecs}
            adcMultiplierOverride={adcMultiplierOverride}
            setAdcMultiplierOverride={setAdcMultiplierOverride}
            waitBluetoothSecs={waitBluetoothSecs}
            setWaitBluetoothSecs={setWaitBluetoothSecs}
            sdsSecs={sdsSecs}
            setSdsSecs={setSdsSecs}
            lsSecs={lsSecs}
            setLsSecs={setLsSecs}
            minWakeSecs={minWakeSecs}
            setMinWakeSecs={setMinWakeSecs}
            deviceBatteryInaAddress={deviceBatteryInaAddress}
            setDeviceBatteryInaAddress={setDeviceBatteryInaAddress}
            isSaving={isSaving}
            onSave={handleSavePowerConfig}
          />
        </div>

        <div id="config-display">
          <DisplayConfigSection
            screenOnSecs={screenOnSecs}
            setScreenOnSecs={setScreenOnSecs}
            autoScreenCarouselSecs={autoScreenCarouselSecs}
            setAutoScreenCarouselSecs={setAutoScreenCarouselSecs}
            flipScreen={flipScreen}
            setFlipScreen={setFlipScreen}
            units={displayUnits}
            setUnits={setDisplayUnits}
            oled={oled}
            setOled={setOled}
            displayMode={displayMode}
            setDisplayMode={setDisplayMode}
            headingBold={headingBold}
            setHeadingBold={setHeadingBold}
            wakeOnTapOrMotion={wakeOnTapOrMotion}
            setWakeOnTapOrMotion={setWakeOnTapOrMotion}
            compassOrientation={compassOrientation}
            setCompassOrientation={setCompassOrientation}
            isSaving={isSaving}
            onSave={handleSaveDisplayConfig}
          />
        </div>

        <div id="config-telemetry">
          <TelemetryConfigSection
            configVersion={telemetryConfigVersion}
            deviceUpdateInterval={deviceUpdateInterval}
            setDeviceUpdateInterval={setDeviceUpdateInterval}
            deviceTelemetryEnabled={deviceTelemetryEnabled}
            setDeviceTelemetryEnabled={setDeviceTelemetryEnabled}
            environmentUpdateInterval={environmentUpdateInterval}
            setEnvironmentUpdateInterval={setEnvironmentUpdateInterval}
            environmentMeasurementEnabled={environmentMeasurementEnabled}
            setEnvironmentMeasurementEnabled={setEnvironmentMeasurementEnabled}
            environmentScreenEnabled={environmentScreenEnabled}
            setEnvironmentScreenEnabled={setEnvironmentScreenEnabled}
            environmentDisplayFahrenheit={environmentDisplayFahrenheit}
            setEnvironmentDisplayFahrenheit={setEnvironmentDisplayFahrenheit}
            airQualityEnabled={airQualityEnabled}
            setAirQualityEnabled={setAirQualityEnabled}
            airQualityInterval={airQualityInterval}
            setAirQualityInterval={setAirQualityInterval}
            powerMeasurementEnabled={powerMeasurementEnabled}
            setPowerMeasurementEnabled={setPowerMeasurementEnabled}
            powerUpdateInterval={powerUpdateInterval}
            setPowerUpdateInterval={setPowerUpdateInterval}
            powerScreenEnabled={powerScreenEnabled}
            setPowerScreenEnabled={setPowerScreenEnabled}
            healthMeasurementEnabled={healthMeasurementEnabled}
            setHealthMeasurementEnabled={setHealthMeasurementEnabled}
            healthUpdateInterval={healthUpdateInterval}
            setHealthUpdateInterval={setHealthUpdateInterval}
            healthScreenEnabled={healthScreenEnabled}
            setHealthScreenEnabled={setHealthScreenEnabled}
            isSaving={isSaving}
            onSave={handleSaveTelemetryConfig}
          />
        </div>

        <div id="config-mqtt">
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
            tlsEnabled={mqttTlsEnabled}
            setTlsEnabled={setMqttTlsEnabled}
            proxyToClientEnabled={mqttProxyToClientEnabled}
            setProxyToClientEnabled={setMqttProxyToClientEnabled}
            mapReportingEnabled={mqttMapReportingEnabled}
            setMapReportingEnabled={setMqttMapReportingEnabled}
            mapPublishIntervalSecs={mqttMapPublishIntervalSecs}
            setMapPublishIntervalSecs={setMqttMapPublishIntervalSecs}
            mapPositionPrecision={mqttMapPositionPrecision}
            setMapPositionPrecision={setMqttMapPositionPrecision}
            isSaving={isSaving}
            onSave={handleSaveMQTTConfig}
          />
        </div>

        <div id="config-neighbor">
          <NeighborInfoSection
            neighborInfoEnabled={neighborInfoEnabled}
            setNeighborInfoEnabled={setNeighborInfoEnabled}
            neighborInfoInterval={neighborInfoInterval}
            setNeighborInfoInterval={setNeighborInfoInterval}
            neighborInfoTransmitOverLora={neighborInfoTransmitOverLora}
            setNeighborInfoTransmitOverLora={setNeighborInfoTransmitOverLora}
            isSaving={isSaving}
            onSave={handleSaveNeighborInfoConfig}
          />
        </div>

        <div id="config-network">
          <NetworkConfigSection
            wifiEnabled={wifiEnabled}
            setWifiEnabled={setWifiEnabled}
            wifiSsid={wifiSsid}
            setWifiSsid={setWifiSsid}
            wifiPsk={wifiPsk}
            setWifiPsk={setWifiPsk}
            ntpServer={ntpServer}
            setNtpServer={setNtpServer}
            addressMode={addressMode}
            setAddressMode={setAddressMode}
            ipv4Address={ipv4Address}
            setIpv4Address={setIpv4Address}
            ipv4Gateway={ipv4Gateway}
            setIpv4Gateway={setIpv4Gateway}
            ipv4Subnet={ipv4Subnet}
            setIpv4Subnet={setIpv4Subnet}
            ipv4Dns={ipv4Dns}
            setIpv4Dns={setIpv4Dns}
            isSaving={isSaving}
            onSave={handleSaveNetworkConfig}
          />
        </div>

        <div id="config-extnotif">
          <ExternalNotificationConfigSection
            enabled={extNotifEnabled}
            setEnabled={setExtNotifEnabled}
            outputMs={extNotifOutputMs}
            setOutputMs={setExtNotifOutputMs}
            output={extNotifOutput}
            setOutput={setExtNotifOutput}
            active={extNotifActive}
            setActive={setExtNotifActive}
            alertMessage={extNotifAlertMessage}
            setAlertMessage={setExtNotifAlertMessage}
            alertMessageVibra={extNotifAlertMessageVibra}
            setAlertMessageVibra={setExtNotifAlertMessageVibra}
            alertMessageBuzzer={extNotifAlertMessageBuzzer}
            setAlertMessageBuzzer={setExtNotifAlertMessageBuzzer}
            alertBell={extNotifAlertBell}
            setAlertBell={setExtNotifAlertBell}
            alertBellVibra={extNotifAlertBellVibra}
            setAlertBellVibra={setExtNotifAlertBellVibra}
            alertBellBuzzer={extNotifAlertBellBuzzer}
            setAlertBellBuzzer={setExtNotifAlertBellBuzzer}
            usePwm={extNotifUsePwm}
            setUsePwm={setExtNotifUsePwm}
            nagTimeout={extNotifNagTimeout}
            setNagTimeout={setExtNotifNagTimeout}
            useI2sAsBuzzer={extNotifUseI2sAsBuzzer}
            setUseI2sAsBuzzer={setExtNotifUseI2sAsBuzzer}
            outputVibra={extNotifOutputVibra}
            setOutputVibra={setExtNotifOutputVibra}
            outputBuzzer={extNotifOutputBuzzer}
            setOutputBuzzer={setExtNotifOutputBuzzer}
            isSaving={isSaving}
            onSave={handleSaveExternalNotificationConfig}
          />
        </div>

        <div id="config-storeforward">
          <StoreForwardConfigSection
            enabled={storeForwardEnabled}
            setEnabled={setStoreForwardEnabled}
            heartbeat={storeForwardHeartbeat}
            setHeartbeat={setStoreForwardHeartbeat}
            records={storeForwardRecords}
            setRecords={setStoreForwardRecords}
            historyReturnMax={storeForwardHistoryReturnMax}
            setHistoryReturnMax={setStoreForwardHistoryReturnMax}
            historyReturnWindow={storeForwardHistoryReturnWindow}
            setHistoryReturnWindow={setStoreForwardHistoryReturnWindow}
            isServer={storeForwardIsServer}
            setIsServer={setStoreForwardIsServer}
            isSaving={isSaving}
            onSave={handleSaveStoreForwardConfig}
          />
        </div>

        <div id="config-rangetest">
          <RangeTestConfigSection
            enabled={rangeTestEnabled}
            setEnabled={setRangeTestEnabled}
            sender={rangeTestSender}
            setSender={setRangeTestSender}
            save={rangeTestSave}
            setSave={setRangeTestSave}
            isSaving={isSaving}
            onSave={handleSaveRangeTestConfig}
          />
        </div>

        <div id="config-cannedmsg">
          <CannedMessageConfigSection
            enabled={cannedMsgEnabled}
            setEnabled={setCannedMsgEnabled}
            rotary1Enabled={cannedMsgRotary1Enabled}
            setRotary1Enabled={setCannedMsgRotary1Enabled}
            inputbrokerPinA={cannedMsgInputbrokerPinA}
            setInputbrokerPinA={setCannedMsgInputbrokerPinA}
            inputbrokerPinB={cannedMsgInputbrokerPinB}
            setInputbrokerPinB={setCannedMsgInputbrokerPinB}
            inputbrokerPinPress={cannedMsgInputbrokerPinPress}
            setInputbrokerPinPress={setCannedMsgInputbrokerPinPress}
            inputbrokerEventCw={cannedMsgInputbrokerEventCw}
            setInputbrokerEventCw={setCannedMsgInputbrokerEventCw}
            inputbrokerEventCcw={cannedMsgInputbrokerEventCcw}
            setInputbrokerEventCcw={setCannedMsgInputbrokerEventCcw}
            inputbrokerEventPress={cannedMsgInputbrokerEventPress}
            setInputbrokerEventPress={setCannedMsgInputbrokerEventPress}
            updown1Enabled={cannedMsgUpdown1Enabled}
            setUpdown1Enabled={setCannedMsgUpdown1Enabled}
            sendBell={cannedMsgSendBell}
            setSendBell={setCannedMsgSendBell}
            allowInputSource={cannedMsgAllowInputSource}
            setAllowInputSource={setCannedMsgAllowInputSource}
            isSaving={isSaving}
            onSave={handleSaveCannedMessageConfig}
          />
        </div>

        <div id="config-audio">
          <AudioConfigSection
            codec2Enabled={audioCodec2Enabled}
            setCodec2Enabled={setAudioCodec2Enabled}
            pttPin={audioPttPin}
            setPttPin={setAudioPttPin}
            bitrate={audioBitrate}
            setBitrate={setAudioBitrate}
            i2sWs={audioI2sWs}
            setI2sWs={setAudioI2sWs}
            i2sSd={audioI2sSd}
            setI2sSd={setAudioI2sSd}
            i2sDin={audioI2sDin}
            setI2sDin={setAudioI2sDin}
            i2sSck={audioI2sSck}
            setI2sSck={setAudioI2sSck}
            isSaving={isSaving}
            onSave={handleSaveAudioConfig}
          />
        </div>

        <div id="config-remotehardware">
          <RemoteHardwareConfigSection
            enabled={remoteHardwareEnabled}
            setEnabled={setRemoteHardwareEnabled}
            allowUndefinedPinAccess={remoteHardwareAllowUndefinedPinAccess}
            setAllowUndefinedPinAccess={setRemoteHardwareAllowUndefinedPinAccess}
            isSaving={isSaving}
            onSave={handleSaveRemoteHardwareConfig}
          />
        </div>

        <div id="config-detectionsensor">
          <DetectionSensorConfigSection
            enabled={detectionSensorEnabled}
            setEnabled={setDetectionSensorEnabled}
            minimumBroadcastSecs={detectionSensorMinimumBroadcastSecs}
            setMinimumBroadcastSecs={setDetectionSensorMinimumBroadcastSecs}
            stateBroadcastSecs={detectionSensorStateBroadcastSecs}
            setStateBroadcastSecs={setDetectionSensorStateBroadcastSecs}
            sendBell={detectionSensorSendBell}
            setSendBell={setDetectionSensorSendBell}
            name={detectionSensorName}
            setName={setDetectionSensorName}
            monitorPin={detectionSensorMonitorPin}
            setMonitorPin={setDetectionSensorMonitorPin}
            detectionTriggerType={detectionSensorDetectionTriggerType}
            setDetectionTriggerType={setDetectionSensorDetectionTriggerType}
            usePullup={detectionSensorUsePullup}
            setUsePullup={setDetectionSensorUsePullup}
            isSaving={isSaving}
            onSave={handleSaveDetectionSensorConfig}
          />
        </div>

        <div id="config-paxcounter">
          <PaxcounterConfigSection
            enabled={paxcounterEnabled}
            setEnabled={setPaxcounterEnabled}
            paxcounterUpdateInterval={paxcounterUpdateInterval}
            setPaxcounterUpdateInterval={setPaxcounterUpdateInterval}
            wifiThreshold={paxcounterWifiThreshold}
            setWifiThreshold={setPaxcounterWifiThreshold}
            bleThreshold={paxcounterBleThreshold}
            setBleThreshold={setPaxcounterBleThreshold}
            isSaving={isSaving}
            onSave={handleSavePaxcounterConfig}
          />
        </div>

        <div id="config-statusmessage">
          <StatusMessageConfigSection
            nodeStatus={statusMessageNodeStatus}
            setNodeStatus={setStatusMessageNodeStatus}
            isDisabled={!supportedModules?.statusmessage}
            isSaving={isSaving}
            onSave={handleSaveStatusMessageConfig}
          />
        </div>

        <div id="config-trafficmanagement">
          <TrafficManagementConfigSection
            enabled={trafficManagementEnabled}
            setEnabled={setTrafficManagementEnabled}
            positionDedupEnabled={trafficManagementPositionDedupEnabled}
            setPositionDedupEnabled={setTrafficManagementPositionDedupEnabled}
            positionDedupTimeSecs={trafficManagementPositionDedupTimeSecs}
            setPositionDedupTimeSecs={setTrafficManagementPositionDedupTimeSecs}
            positionDedupDistanceMeters={trafficManagementPositionDedupDistanceMeters}
            setPositionDedupDistanceMeters={setTrafficManagementPositionDedupDistanceMeters}
            nodeinfoDirectResponseEnabled={trafficManagementNodeinfoDirectResponseEnabled}
            setNodeinfoDirectResponseEnabled={setTrafficManagementNodeinfoDirectResponseEnabled}
            nodeinfoDirectResponseMyNodeOnly={trafficManagementNodeinfoDirectResponseMyNodeOnly}
            setNodeinfoDirectResponseMyNodeOnly={setTrafficManagementNodeinfoDirectResponseMyNodeOnly}
            rateLimitEnabled={trafficManagementRateLimitEnabled}
            setRateLimitEnabled={setTrafficManagementRateLimitEnabled}
            rateLimitMaxPerNode={trafficManagementRateLimitMaxPerNode}
            setRateLimitMaxPerNode={setTrafficManagementRateLimitMaxPerNode}
            rateLimitWindowSecs={trafficManagementRateLimitWindowSecs}
            setRateLimitWindowSecs={setTrafficManagementRateLimitWindowSecs}
            unknownPacketDropEnabled={trafficManagementUnknownPacketDropEnabled}
            setUnknownPacketDropEnabled={setTrafficManagementUnknownPacketDropEnabled}
            unknownPacketGracePeriodSecs={trafficManagementUnknownPacketGracePeriodSecs}
            setUnknownPacketGracePeriodSecs={setTrafficManagementUnknownPacketGracePeriodSecs}
            hopExhaustionEnabled={trafficManagementHopExhaustionEnabled}
            setHopExhaustionEnabled={setTrafficManagementHopExhaustionEnabled}
            hopExhaustionMinHops={trafficManagementHopExhaustionMinHops}
            setHopExhaustionMinHops={setTrafficManagementHopExhaustionMinHops}
            hopExhaustionMaxHops={trafficManagementHopExhaustionMaxHops}
            setHopExhaustionMaxHops={setTrafficManagementHopExhaustionMaxHops}
            isDisabled={!supportedModules?.trafficManagement}
            isSaving={isSaving}
            onSave={handleSaveTrafficManagementConfig}
          />
        </div>

        <div id="config-serial">
          <SerialConfigSection
            enabled={serialEnabled}
            setEnabled={setSerialEnabled}
            echo={serialEcho}
            setEcho={setSerialEcho}
            rxd={serialRxd}
            setRxd={setSerialRxd}
            txd={serialTxd}
            setTxd={setSerialTxd}
            baud={serialBaud}
            setBaud={setSerialBaud}
            timeout={serialTimeout}
            setTimeout={setSerialTimeout}
            mode={serialMode}
            setMode={setSerialMode}
            overrideConsoleSerialPort={serialOverrideConsoleSerialPort}
            setOverrideConsoleSerialPort={setSerialOverrideConsoleSerialPort}
            isSaving={isSaving}
            onSave={handleSaveSerialConfig}
          />
        </div>

        <div id="config-ambientlighting">
          <AmbientLightingConfigSection
            ledState={ambientLedState}
            setLedState={setAmbientLedState}
            current={ambientCurrent}
            setCurrent={setAmbientCurrent}
            red={ambientRed}
            setRed={setAmbientRed}
            green={ambientGreen}
            setGreen={setAmbientGreen}
            blue={ambientBlue}
            setBlue={setAmbientBlue}
            isSaving={isSaving}
            onSave={handleSaveAmbientLightingConfig}
          />
        </div>

        <div id="config-security">
          <SecurityConfigSection
            publicKey={securityPublicKey}
            privateKey={securityPrivateKey}
            adminKeys={securityAdminKeys}
            isManaged={securityIsManaged}
            serialEnabled={securitySerialEnabled}
            debugLogApiEnabled={securityDebugLogApiEnabled}
            adminChannelEnabled={securityAdminChannelEnabled}
            setAdminKeys={setSecurityAdminKeys}
            setIsManaged={setSecurityIsManaged}
            setSerialEnabled={setSecuritySerialEnabled}
            setDebugLogApiEnabled={setSecurityDebugLogApiEnabled}
            setAdminChannelEnabled={setSecurityAdminChannelEnabled}
            isSaving={isSaving}
            onSave={handleSaveSecurityConfig}
          />
        </div>

        <div id="config-channels">
          <ChannelsConfigSection
            channels={channels}
            onChannelsUpdated={onChannelsUpdated}
          />
        </div>

        <div id="config-channel-database">
          <ChannelDatabaseSection
            isAdmin={authStatus?.user?.isAdmin ?? false}
            rebroadcastMode={rebroadcastMode}
          />
        </div>

        <div id="config-backup">
          <BackupManagementSection />
        </div>
      </div>{/* End settings-content */}

        </div>{/* End main content column */}

        {/* GPIO Pin Summary sidebar - only show on larger screens */}
        <div className="gpio-summary-sidebar" style={{
          width: '280px',
          flexShrink: 0,
          alignSelf: 'flex-start',
          position: 'sticky',
          top: '1rem',
          display: 'none' // Hidden by default, shown via media query
        }}>
          <GpioPinSummary
            buttonGpio={buttonGpio}
            buzzerGpio={buzzerGpio}
            rxGpio={rxGpio}
            txGpio={txGpio}
            gpsEnGpio={gpsEnGpio}
            extNotifOutput={extNotifOutput}
            extNotifOutputVibra={extNotifOutputVibra}
            extNotifOutputBuzzer={extNotifOutputBuzzer}
            cannedMsgInputbrokerPinA={cannedMsgInputbrokerPinA}
            cannedMsgInputbrokerPinB={cannedMsgInputbrokerPinB}
            cannedMsgInputbrokerPinPress={cannedMsgInputbrokerPinPress}
            audioPttPin={audioPttPin}
            audioI2sWs={audioI2sWs}
            audioI2sSd={audioI2sSd}
            audioI2sDin={audioI2sDin}
            audioI2sSck={audioI2sSck}
            detectionSensorMonitorPin={detectionSensorMonitorPin}
            serialRxd={serialRxd}
            serialTxd={serialTxd}
          />
        </div>
      </div>{/* End two-column layout */}

      {/* Import/Export Modals */}
      <ImportConfigModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImportSuccess={() => {
          showToast(t('config.import_success'), 'success');
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
