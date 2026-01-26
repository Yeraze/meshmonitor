import React, { useState, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';

// Address mode options from protobufs
const ADDRESS_MODE_OPTIONS = [
  { value: 0, label: 'DHCP' },
  { value: 1, label: 'STATIC' },
];

interface NetworkConfigSectionProps {
  wifiEnabled: boolean;
  setWifiEnabled: (value: boolean) => void;
  wifiSsid: string;
  setWifiSsid: (value: string) => void;
  wifiPsk: string;
  setWifiPsk: (value: string) => void;
  ntpServer: string;
  setNtpServer: (value: string) => void;
  addressMode: number;
  setAddressMode: (value: number) => void;
  // Static IP config
  ipv4Address: string;
  setIpv4Address: (value: string) => void;
  ipv4Gateway: string;
  setIpv4Gateway: (value: string) => void;
  ipv4Subnet: string;
  setIpv4Subnet: (value: string) => void;
  ipv4Dns: string;
  setIpv4Dns: (value: string) => void;
  // UI state
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const NetworkConfigSection: React.FC<NetworkConfigSectionProps> = ({
  wifiEnabled,
  setWifiEnabled,
  wifiSsid,
  setWifiSsid,
  wifiPsk,
  setWifiPsk,
  ntpServer,
  setNtpServer,
  addressMode,
  setAddressMode,
  ipv4Address,
  setIpv4Address,
  ipv4Gateway,
  setIpv4Gateway,
  ipv4Subnet,
  setIpv4Subnet,
  ipv4Dns,
  setIpv4Dns,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();
  const [showPassword, setShowPassword] = useState(false);

  // Track initial values for change detection
  const initialValuesRef = useRef({
    wifiEnabled, wifiSsid, wifiPsk, ntpServer, addressMode,
    ipv4Address, ipv4Gateway, ipv4Subnet, ipv4Dns
  });

  // Calculate if there are unsaved changes
  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      wifiEnabled !== initial.wifiEnabled ||
      wifiSsid !== initial.wifiSsid ||
      wifiPsk !== initial.wifiPsk ||
      ntpServer !== initial.ntpServer ||
      addressMode !== initial.addressMode ||
      ipv4Address !== initial.ipv4Address ||
      ipv4Gateway !== initial.ipv4Gateway ||
      ipv4Subnet !== initial.ipv4Subnet ||
      ipv4Dns !== initial.ipv4Dns
    );
  }, [wifiEnabled, wifiSsid, wifiPsk, ntpServer, addressMode,
      ipv4Address, ipv4Gateway, ipv4Subnet, ipv4Dns]);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setWifiEnabled(initial.wifiEnabled);
    setWifiSsid(initial.wifiSsid);
    setWifiPsk(initial.wifiPsk);
    setNtpServer(initial.ntpServer);
    setAddressMode(initial.addressMode);
    setIpv4Address(initial.ipv4Address);
    setIpv4Gateway(initial.ipv4Gateway);
    setIpv4Subnet(initial.ipv4Subnet);
    setIpv4Dns(initial.ipv4Dns);
  }, [setWifiEnabled, setWifiSsid, setWifiPsk, setNtpServer, setAddressMode,
      setIpv4Address, setIpv4Gateway, setIpv4Subnet, setIpv4Dns]);

  // Update initial values after successful save
  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = {
      wifiEnabled, wifiSsid, wifiPsk, ntpServer, addressMode,
      ipv4Address, ipv4Gateway, ipv4Subnet, ipv4Dns
    };
  }, [onSave, wifiEnabled, wifiSsid, wifiPsk, ntpServer, addressMode,
      ipv4Address, ipv4Gateway, ipv4Subnet, ipv4Dns]);

  // Register with SaveBar
  useSaveBar({
    id: 'network-config',
    sectionName: t('network_config.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges
  });

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('network_config.title')}
        <a
          href="https://meshmonitor.org/features/device#network-configuration"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('network_config.view_docs')}
        >
          ❓
        </a>
      </h3>

      {/* WiFi Enable */}
      <div className="setting-item">
        <label htmlFor="wifiEnabled">
          {t('network_config.wifi_enabled')}
          <span className="setting-description">{t('network_config.wifi_enabled_description')}</span>
        </label>
        <input
          id="wifiEnabled"
          type="checkbox"
          checked={wifiEnabled}
          onChange={(e) => setWifiEnabled(e.target.checked)}
          className="setting-checkbox"
        />
      </div>

      {/* WiFi Settings - only show when WiFi is enabled */}
      {wifiEnabled && (
        <>
          {/* WiFi SSID */}
          <div className="setting-item">
            <label htmlFor="wifiSsid">
              {t('network_config.wifi_ssid')}
              <span className="setting-description">{t('network_config.wifi_ssid_description')}</span>
            </label>
            <input
              id="wifiSsid"
              type="text"
              value={wifiSsid}
              onChange={(e) => setWifiSsid(e.target.value)}
              placeholder="MyNetwork"
              maxLength={32}
              className="setting-input"
              style={{ width: '300px' }}
            />
          </div>

          {/* WiFi Password */}
          <div className="setting-item">
            <label htmlFor="wifiPsk">
              {t('network_config.wifi_psk')}
              <span className="setting-description">{t('network_config.wifi_psk_description')}</span>
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                id="wifiPsk"
                type={showPassword ? 'text' : 'password'}
                value={wifiPsk}
                onChange={(e) => setWifiPsk(e.target.value)}
                placeholder="••••••••"
                maxLength={63}
                className="setting-input"
                style={{ width: '300px' }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--ctp-surface2)',
                  color: 'var(--ctp-subtext0)',
                  padding: '0.5rem',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                {showPassword ? '🙈' : '👁️'}
              </button>
            </div>
          </div>

          {/* Address Mode */}
          <div className="setting-item">
            <label htmlFor="addressMode">
              {t('network_config.address_mode')}
              <span className="setting-description">{t('network_config.address_mode_description')}</span>
            </label>
            <select
              id="addressMode"
              value={addressMode}
              onChange={(e) => setAddressMode(parseInt(e.target.value))}
              className="setting-input"
            >
              {ADDRESS_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {/* Static IP Settings - only show when address mode is STATIC (1) */}
          {addressMode === 1 && (
            <div style={{
              marginLeft: '1rem',
              paddingLeft: '1rem',
              borderLeft: '2px solid var(--ctp-surface2)',
              marginTop: '1rem'
            }}>
              <h4 style={{ marginBottom: '1rem', color: 'var(--ctp-subtext0)' }}>
                {t('network_config.static_ip_settings')}
              </h4>

              {/* IP Address */}
              <div className="setting-item">
                <label htmlFor="ipv4Address">
                  {t('network_config.ip_address')}
                  <span className="setting-description">{t('network_config.ip_address_description')}</span>
                </label>
                <input
                  id="ipv4Address"
                  type="text"
                  value={ipv4Address}
                  onChange={(e) => setIpv4Address(e.target.value)}
                  placeholder="192.168.1.100"
                  className="setting-input"
                  style={{ width: '200px' }}
                />
              </div>

              {/* Gateway */}
              <div className="setting-item">
                <label htmlFor="ipv4Gateway">
                  {t('network_config.gateway')}
                  <span className="setting-description">{t('network_config.gateway_description')}</span>
                </label>
                <input
                  id="ipv4Gateway"
                  type="text"
                  value={ipv4Gateway}
                  onChange={(e) => setIpv4Gateway(e.target.value)}
                  placeholder="192.168.1.1"
                  className="setting-input"
                  style={{ width: '200px' }}
                />
              </div>

              {/* Subnet */}
              <div className="setting-item">
                <label htmlFor="ipv4Subnet">
                  {t('network_config.subnet')}
                  <span className="setting-description">{t('network_config.subnet_description')}</span>
                </label>
                <input
                  id="ipv4Subnet"
                  type="text"
                  value={ipv4Subnet}
                  onChange={(e) => setIpv4Subnet(e.target.value)}
                  placeholder="255.255.255.0"
                  className="setting-input"
                  style={{ width: '200px' }}
                />
              </div>

              {/* DNS */}
              <div className="setting-item">
                <label htmlFor="ipv4Dns">
                  {t('network_config.dns')}
                  <span className="setting-description">{t('network_config.dns_description')}</span>
                </label>
                <input
                  id="ipv4Dns"
                  type="text"
                  value={ipv4Dns}
                  onChange={(e) => setIpv4Dns(e.target.value)}
                  placeholder="8.8.8.8"
                  className="setting-input"
                  style={{ width: '200px' }}
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* NTP Server - always show */}
      <div className="setting-item" style={{ marginTop: wifiEnabled ? '1rem' : 0 }}>
        <label htmlFor="ntpServer">
          {t('network_config.ntp_server')}
          <span className="setting-description">{t('network_config.ntp_server_description')}</span>
        </label>
        <input
          id="ntpServer"
          type="text"
          value={ntpServer}
          onChange={(e) => setNtpServer(e.target.value)}
          placeholder="meshtastic.pool.ntp.org"
          maxLength={33}
          className="setting-input"
          style={{ width: '400px' }}
        />
      </div>
    </div>
  );
};

export default NetworkConfigSection;
