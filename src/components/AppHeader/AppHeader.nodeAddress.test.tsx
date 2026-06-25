/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppHeader } from './AppHeader';
import type { AuthStatus } from '../../contexts/AuthContext';

// react-i18next is globally mocked in src/test/setup.ts (t(key) => key).

// UserMenu calls useAuth() — provide a minimal mock so tests that render the
// authenticated header state (authStatus.authenticated = true) don't require
// a full AuthProvider tree.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    authStatus: { authenticated: true, user: { username: 'admin' } },
    logout: vi.fn(),
    hasPermission: () => false,
  }),
}));

function baseProps(overrides: Partial<React.ComponentProps<typeof AppHeader>> = {}) {
  const props: React.ComponentProps<typeof AppHeader> = {
    baseUrl: '',
    nodeAddress: '',
    currentNodeId: '',
    nodes: [],
    deviceInfo: null,
    // Unauthenticated → UserMenu is not rendered (avoids unrelated deps).
    authStatus: { authenticated: false } as AuthStatus,
    connectionStatus: 'disconnected',
    webSocketConnected: false,
    hasPermission: () => false,
    onFetchSystemStatus: vi.fn(),
    onDisconnect: vi.fn(),
    onReconnect: vi.fn(),
    onShowLoginModal: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  };
  return props;
}

describe('AppHeader — node address never leaks the loading placeholder (#3611)', () => {
  it('does not render the literal "Loading..." when nodeAddress is unresolved (empty)', () => {
    const { container } = render(<AppHeader {...baseProps({ nodeAddress: '' })} />);
    expect(container.textContent).not.toContain('Loading...');
  });

  it('does not render "Loading..." even if a stale placeholder were passed in', () => {
    // Defensive: even if some caller still passed the old placeholder, the header
    // must never surface it in the connection-status area.
    const { container } = render(<AppHeader {...baseProps({ nodeAddress: 'Loading...' })} />);
    // The connection-status text comes from translation keys, not nodeAddress.
    const statusArea = container.querySelector('.connection-status');
    expect(statusArea?.textContent ?? '').not.toContain('Loading...');
  });

  it('renders the per-source address for authenticated users', () => {
    render(<AppHeader {...baseProps({
      nodeAddress: '10.20.30.40:4403',
      authStatus: { authenticated: true } as AuthStatus,
    })} />);
    expect(screen.getByText('10.20.30.40:4403')).toBeInTheDocument();
  });
});

describe('AppHeader — node identity hidden from unauthenticated users (#3729)', () => {
  it('does not show node-info div to unauthenticated users', () => {
    const { container } = render(<AppHeader {...baseProps({
      nodeAddress: '10.20.30.40:4403',
      deviceInfo: { localNodeInfo: { nodeId: '!aabbccdd', longName: 'Test Node', shortName: 'TN' } },
      authStatus: { authenticated: false } as AuthStatus,
    })} />);
    expect(container.querySelector('.node-info')).toBeNull();
  });

  it('shows node identity to authenticated users', () => {
    render(<AppHeader {...baseProps({
      deviceInfo: { localNodeInfo: { nodeId: '!aabbccdd', longName: 'Test Node', shortName: 'TN' } },
      authStatus: { authenticated: true } as AuthStatus,
    })} />);
    expect(screen.getByText(/Test Node/)).toBeInTheDocument();
  });
});
