/**
 * @vitest-environment jsdom
 *
 * Tests for NetworkConfigSection's bridged-node notice.
 *
 * Every setting in the Network section (WiFi, Ethernet, NTP, syslog, static IP)
 * is inert on a bridged node — a serial/BLE radio fronted by a TCP proxy with no
 * native IP hardware — so we surface an informational notice when isBridged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: () => {},
}));

import NetworkConfigSection from './NetworkConfigSection';

const baseProps = {
  wifiEnabled: false,
  setWifiEnabled: vi.fn(),
  wifiSsid: '',
  setWifiSsid: vi.fn(),
  wifiPsk: '',
  setWifiPsk: vi.fn(),
  ntpServer: '',
  setNtpServer: vi.fn(),
  rsyslogServer: '',
  setRsyslogServer: vi.fn(),
  addressMode: 0,
  setAddressMode: vi.fn(),
  ipv4Address: '',
  setIpv4Address: vi.fn(),
  ipv4Gateway: '',
  setIpv4Gateway: vi.fn(),
  ipv4Subnet: '',
  setIpv4Subnet: vi.fn(),
  ipv4Dns: '',
  setIpv4Dns: vi.fn(),
  isSaving: false,
  onSave: vi.fn(async () => {}),
};

beforeEach(() => vi.clearAllMocks());

describe('NetworkConfigSection — bridged-node inert notice', () => {
  it('renders the inert notice when isBridged is true', () => {
    render(<NetworkConfigSection {...baseProps} isBridged={true} />);
    expect(screen.getByTestId('network-bridged-note')).toBeInTheDocument();
  });

  it('does not render the notice when isBridged is false', () => {
    render(<NetworkConfigSection {...baseProps} isBridged={false} />);
    expect(screen.queryByTestId('network-bridged-note')).toBeNull();
  });

  it('does not render the notice when isBridged is omitted', () => {
    render(<NetworkConfigSection {...baseProps} />);
    expect(screen.queryByTestId('network-bridged-note')).toBeNull();
  });
});
