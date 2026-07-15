/**
 * @vitest-environment jsdom
 *
 * Regression: the Channels nav entry must be reachable for users whose only
 * channel access is to virtual (Channel Database) channels — e.g. an anonymous
 * viewer granted per-entry `canRead` on an MQTT source. Previously
 * `hasAnyChannelPermission` only checked physical slots `channel_0..7`, so such
 * a user saw no Channels entry at all ("no Channels display").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import Sidebar from './Sidebar';
import type { ResourceType } from '../types/permission';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({ iconStyle: 'lucide' }),
}));

const baseProps = {
  activeTab: 'nodes' as const,
  setActiveTab: vi.fn(),
  isAdmin: false,
  isAuthenticated: false, // anonymous
  unreadCounts: {},
  unreadCountsData: null,
  onMessagesClick: vi.fn(),
  onChannelsClick: vi.fn(),
  baseUrl: '',
};

/** hasPermission that denies everything (no physical channel_0..7 grants). */
const denyAll = () => false;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Sidebar — Channels entry visibility for virtual-channel-only users', () => {
  it('hides Channels when the user has no physical and no virtual channel access', () => {
    render(<Sidebar {...baseProps} hasPermission={denyAll} hasReadableVirtualChannels={false} />);
    expect(screen.queryByTitle('nav.channels')).toBeNull();
  });

  it('shows Channels when the user can read a virtual channel (no physical grants)', () => {
    render(<Sidebar {...baseProps} hasPermission={denyAll} hasReadableVirtualChannels={true} />);
    expect(screen.queryByTitle('nav.channels')).not.toBeNull();
  });

  it('still shows Channels for a physical channel_0 grant (baseline unchanged)', () => {
    const allowChannel0 = (resource: ResourceType, action: 'read' | 'write') =>
      resource === 'channel_0' && action === 'read';
    render(
      <Sidebar {...baseProps} hasPermission={allowChannel0} hasReadableVirtualChannels={false} />,
    );
    expect(screen.queryByTitle('nav.channels')).not.toBeNull();
  });
});
