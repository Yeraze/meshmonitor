/**
 * @vitest-environment jsdom
 *
 * Remote Admin "Available" badge shortcut (#5535): clicking the badge opens
 * the Admin Commands tab with the node pre-selected. See `RemoteAdminLink.
 * test.tsx` for the link's own behaviour; these tests only check that
 * `NodeDetailsBlock` wires it up correctly — interactive with `canOpenRemoteAdmin`
 * and a verified-available node, inert otherwise — and, since this suite
 * renders without a Router like its siblings, that it falls back to a plain
 * `<a>` rather than throwing.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NodeDetailsBlock from './NodeDetailsBlock';
import type { DeviceInfo } from '../types/device';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../hooks/useServerData', () => ({
  useChannels: () => ({ channels: [] }),
  useDeviceConfig: () => ({ currentNodeId: null }),
}));
vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ nodeHopsCalculation: 'client' }),
}));
vi.mock('../contexts/MapContext', () => ({
  useMapContext: () => ({ traceroutes: [] }),
}));
vi.mock('./NodeDetailsBlock.css', () => ({}));

const availableNode: DeviceInfo = {
  nodeNum: 0x0000007b,
  user: { id: '!0000007b', longName: 'Remote Node', shortName: 'RN', role: 'CLIENT' },
  hasRemoteAdmin: true,
  lastRemoteAdminCheck: Date.now() - 1000,
};

describe('NodeDetailsBlock Remote Admin "Available" badge shortcut', () => {
  it('renders the badge as an accessible link to the node, pre-selected, when permitted', () => {
    render(
      <MemoryRouter>
        <NodeDetailsBlock node={availableNode} canOpenRemoteAdmin />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /open remote admin for remote node/i });
    expect(decodeURIComponent(link.getAttribute('href') ?? '')).toBe('/admin?node=!0000007b');
    // The existing badge look is preserved inside the link.
    expect(screen.getByText('node_details.remote_admin_yes')).toBeInTheDocument();
  });

  it('renders inert text (no link) when the caller omits canOpenRemoteAdmin', () => {
    render(
      <MemoryRouter>
        <NodeDetailsBlock node={availableNode} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: /open remote admin/i })).not.toBeInTheDocument();
    expect(screen.getByText('node_details.remote_admin_yes')).toBeInTheDocument();
  });

  it('renders inert text (no link) when canOpenRemoteAdmin is explicitly false', () => {
    render(
      <MemoryRouter>
        <NodeDetailsBlock node={availableNode} canOpenRemoteAdmin={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: /open remote admin/i })).not.toBeInTheDocument();
  });

  it('renders inert text when the node is not admin-capable, even when permitted', () => {
    const unavailableNode: DeviceInfo = {
      ...availableNode,
      hasRemoteAdmin: false,
    };
    render(
      <MemoryRouter>
        <NodeDetailsBlock node={unavailableNode} canOpenRemoteAdmin />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: /open remote admin/i })).not.toBeInTheDocument();
    expect(screen.getByText('node_details.remote_admin_no')).toBeInTheDocument();
  });

  it('renders inert text when never tested, even when permitted', () => {
    const untestedNode: DeviceInfo = {
      ...availableNode,
      hasRemoteAdmin: false,
      lastRemoteAdminCheck: undefined,
    };
    render(
      <MemoryRouter>
        <NodeDetailsBlock node={untestedNode} canOpenRemoteAdmin />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: /open remote admin/i })).not.toBeInTheDocument();
    expect(screen.getByText('node_details.remote_admin_unknown')).toBeInTheDocument();
  });

  it('falls back to a plain <a> without throwing when rendered without a Router (matches sibling suites)', () => {
    render(<NodeDetailsBlock node={availableNode} canOpenRemoteAdmin />);
    const link = screen.getByRole('link', { name: /open remote admin for remote node/i });
    expect(link.tagName).toBe('A');
    expect(decodeURIComponent(link.getAttribute('href') ?? '')).toContain('node=!0000007b');
  });

  it('renders inert text when the node has no user.id, even when permitted', () => {
    render(
      <MemoryRouter>
        <NodeDetailsBlock node={{ ...availableNode, user: undefined }} canOpenRemoteAdmin />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: /open remote admin/i })).not.toBeInTheDocument();
  });
});
