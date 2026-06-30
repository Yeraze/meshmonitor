/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

let authPermission: (resource: string, action: string) => boolean = () => true;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (r: string, a: string) => authPermission(r, a) }),
}));

let iconStyle: 'icon' | 'emoji' = 'icon';
vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ iconStyle }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

import { MeshCoreSubToolbar } from './MeshCoreSubToolbar';

describe('MeshCoreSubToolbar', () => {
  it('renders lucide SVG icons (not emoji) in the default icon style', () => {
    authPermission = () => true;
    iconStyle = 'icon';
    const { container } = render(
      <MeshCoreSubToolbar view="nodes" onSelect={() => {}} expanded onToggleExpanded={() => {}} />,
    );
    // Each nav item's .icon span should contain an <svg> from lucide-react.
    const iconSpans = container.querySelectorAll('.meshcore-sub-toolbar-item .icon');
    expect(iconSpans.length).toBeGreaterThan(0);
    iconSpans.forEach((span) => expect(span.querySelector('svg')).not.toBeNull());
  });

  it('renders emoji when the icon style is set to emoji', () => {
    authPermission = () => true;
    iconStyle = 'emoji';
    const { container } = render(
      <MeshCoreSubToolbar view="nodes" onSelect={() => {}} expanded onToggleExpanded={() => {}} />,
    );
    const firstIcon = container.querySelector('.meshcore-sub-toolbar-item .icon');
    expect(firstIcon?.querySelector('svg')).toBeNull();
    expect(firstIcon?.textContent).toBe('🗺️');
    iconStyle = 'icon'; // reset for other tests
  });

  it('renders the Configuration tab when configuration:read is granted', () => {
    authPermission = () => true;
    render(
      <MeshCoreSubToolbar view="nodes" onSelect={() => {}} expanded onToggleExpanded={() => {}} />,
    );
    expect(screen.getByText('Configuration')).toBeDefined();
  });

  it('hides the Configuration tab when configuration:read is denied', () => {
    authPermission = (resource, action) =>
      !(resource === 'configuration' && action === 'read');
    render(
      <MeshCoreSubToolbar view="nodes" onSelect={() => {}} expanded onToggleExpanded={() => {}} />,
    );
    expect(screen.queryByText('Configuration')).toBeNull();
    // Other tabs still visible.
    expect(screen.getByText('Nodes')).toBeDefined();
    expect(screen.getByText('Channels')).toBeDefined();
    expect(screen.getByText('Node Details')).toBeDefined();
    expect(screen.getByText('Settings')).toBeDefined();
  });
});
