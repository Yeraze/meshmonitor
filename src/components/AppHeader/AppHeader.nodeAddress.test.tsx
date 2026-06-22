/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppHeader } from './AppHeader';
import type { AuthStatus } from '../../contexts/AuthContext';

// react-i18next is globally mocked in src/test/setup.ts (t(key) => key).

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

  it('renders the per-source address when it has been resolved', () => {
    render(<AppHeader {...baseProps({ nodeAddress: '10.20.30.40:4403' })} />);
    expect(screen.getByText('10.20.30.40:4403')).toBeInTheDocument();
  });
});
