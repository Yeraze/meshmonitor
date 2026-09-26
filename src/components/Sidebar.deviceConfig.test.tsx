/**
 * @vitest-environment jsdom
 *
 * #5367: an MQTT broker source has no local radio. Its Device Configuration
 * and Remote Admin entries could only reach a different source's device, so
 * `hideDeviceConfig` removes them while leaving the rest of the nav alone.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import Sidebar from './Sidebar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
}));

const baseProps = {
  activeTab: 'nodes' as const,
  setActiveTab: vi.fn(),
  hasPermission: () => true,
  isAdmin: true,
  isAuthenticated: true,
  unreadCounts: {},
  unreadCountsData: null,
  onMessagesClick: vi.fn(),
  onChannelsClick: vi.fn(),
  baseUrl: '',
};

describe('Sidebar — hideDeviceConfig (#5367)', () => {
  it('shows Device Configuration and Remote Admin by default', () => {
    render(<Sidebar {...baseProps} />);
    expect(screen.queryByTitle('nav.device')).not.toBeNull();
    expect(screen.queryByTitle('nav.admin_commands')).not.toBeNull();
  });

  it('hides Device Configuration and Remote Admin when hideDeviceConfig is set', () => {
    render(<Sidebar {...baseProps} hideDeviceConfig />);
    expect(screen.queryByTitle('nav.device')).toBeNull();
    expect(screen.queryByTitle('nav.admin_commands')).toBeNull();
    // The rest of the nav is untouched.
    expect(screen.queryByTitle('nav.settings')).not.toBeNull();
  });
});
