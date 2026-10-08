/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

let authPermission: (resource: string, action: string) => boolean = () => true;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (r: string, a: string) => authPermission(r, a) }),
}));

let iconStyle: 'lucide' | 'emoji' = 'lucide';
vi.mock('../../contexts/IconStyleContext', () => ({
  useIconStyleOptional: () => iconStyle,
}));

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import { MeshCoreSubToolbar } from './MeshCoreSubToolbar';

describe('MeshCoreSubToolbar', () => {
  it('renders lucide SVG icons (not emoji) in the default icon style', () => {
    authPermission = () => true;
    iconStyle = 'lucide';
    const { container } = render(
      <MeshCoreSubToolbar view="nodes" onSelect={() => {}} expanded onToggleExpanded={() => {}} />,
    );
    // Each nav item's icon span should contain an <svg> from lucide-react.
    // Selectors are the stable data-* hooks SourceNav emits (#4473); its class
    // names come from a CSS module and are hashed at build time.
    const iconSpans = container.querySelectorAll('[data-source-nav-item] [data-source-nav-icon]');
    expect(iconSpans.length).toBeGreaterThan(0);
    iconSpans.forEach((span) => expect(span.querySelector('svg')).not.toBeNull());
  });

  it('renders emoji when the icon style is set to emoji', () => {
    authPermission = () => true;
    iconStyle = 'emoji';
    const { container } = render(
      <MeshCoreSubToolbar view="nodes" onSelect={() => {}} expanded onToggleExpanded={() => {}} />,
    );
    const firstIcon = container.querySelector('[data-source-nav-item] [data-source-nav-icon]');
    expect(firstIcon?.querySelector('svg')).toBeNull();
    expect(firstIcon?.textContent).toBe('🗺️');
    iconStyle = 'lucide'; // reset for other tests
  });

  it('renders an unread red-dot only on the flagged nav items (#3891)', () => {
    authPermission = () => true;
    iconStyle = 'lucide';
    const { container } = render(
      <MeshCoreSubToolbar
        view="nodes"
        onSelect={() => {}}
        expanded
        onToggleExpanded={() => {}}
        unread={{ channels: true, dms: false }}
      />,
    );
    const dots = container.querySelectorAll('[data-source-nav-unread]');
    expect(dots.length).toBe(1);
    const channelsItem = Array.from(container.querySelectorAll('[data-source-nav-item]'))
      .find((el) => el.textContent?.includes('Channels'));
    expect(channelsItem?.querySelector('[data-source-nav-unread]')).not.toBeNull();
  });

  it('renders no unread dots when none are flagged', () => {
    authPermission = () => true;
    const { container } = render(
      <MeshCoreSubToolbar view="nodes" onSelect={() => {}} expanded onToggleExpanded={() => {}} />,
    );
    expect(container.querySelectorAll('[data-source-nav-unread]').length).toBe(0);
  });

  it('renders the Configuration tab when configuration:read is granted', () => {
    authPermission = () => true;
    render(
      <MeshCoreSubToolbar view="nodes" onSelect={() => {}} expanded onToggleExpanded={() => {}} />,
    );
    expect(screen.getByText('Device Configuration')).toBeDefined();
  });

  it('hides the Configuration tab when configuration:read is denied', () => {
    authPermission = (resource, action) =>
      !(resource === 'configuration' && action === 'read');
    render(
      <MeshCoreSubToolbar view="nodes" onSelect={() => {}} expanded onToggleExpanded={() => {}} />,
    );
    expect(screen.queryByText('Device Configuration')).toBeNull();
    // Other tabs still visible.
    expect(screen.getByText('Nodes')).toBeDefined();
    expect(screen.getByText('Channels')).toBeDefined();
    expect(screen.getByText('Node Details')).toBeDefined();
    expect(screen.getByText('Settings')).toBeDefined();
  });

  const labels = (container: HTMLElement): string[] =>
    Array.from(container.querySelectorAll('[data-source-nav-item]')).map((el) => el.textContent?.trim() ?? '');
  const renderWith = (grants: string[]) => {
    authPermission = (resource, action) => action === 'read' && grants.includes(resource);
    return render(
      <MeshCoreSubToolbar view="nodes" onSelect={() => {}} expanded onToggleExpanded={() => {}} />,
    );
  };

  it('hides the Settings tab without settings:read (#5666)', () => {
    const { container } = renderWith(['connection', 'nodes', 'channel_0', 'messages', 'configuration', 'automation', 'packetmonitor', 'dashboard']);
    expect(labels(container)).not.toContain('Settings');
    expect(labels(container)).toContain('Device Configuration');
  });

  it('shows the Settings tab with settings:read', () => {
    const { container } = renderWith(['settings']);
    expect(labels(container)).toEqual(['Nodes', 'Node Info', 'Settings']);
  });

  it('the anonymous viewer from #5666 (connection, nodes, channel_0) sees Nodes, Channels and Node Info', () => {
    const { container } = renderWith(['connection', 'nodes', 'channel_0']);
    expect(labels(container)).toEqual(['Nodes', 'Channels', 'Node Info']);
  });

  it('messages:read adds Rooms and Node Details; a channel grant alone does not', () => {
    expect(labels(renderWith(['messages']).container)).toEqual(['Nodes', 'Channels', 'Rooms', 'Node Details', 'Node Info']);
  });

  it('each remaining tab follows its own grant', () => {
    expect(labels(renderWith(['dashboard']).container)).toEqual(['Nodes', 'Telemetry', 'Node Info']);
    expect(labels(renderWith(['packetmonitor']).container)).toEqual(['Nodes', 'Packet Monitor', 'Node Info']);
    expect(labels(renderWith(['automation']).container)).toEqual(['Nodes', 'Node Info', 'Automations']);
  });
});
