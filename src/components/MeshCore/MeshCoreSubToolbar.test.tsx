/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

let authPermission: (resource: string, action: string) => boolean = () => true;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (r: string, a: string) => authPermission(r, a) }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

import { MeshCoreSubToolbar } from './MeshCoreSubToolbar';

describe('MeshCoreSubToolbar', () => {
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
    expect(screen.getByText('Direct Messages')).toBeDefined();
    expect(screen.getByText('Settings')).toBeDefined();
  });
});
