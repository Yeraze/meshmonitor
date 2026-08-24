/**
 * @vitest-environment jsdom
 *
 * #4908: the connection Disconnect/Reconnect control moved out of the app
 * header and into this modal (opened by clicking the header status indicator).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SystemStatusModal } from './SystemStatusModal';
import type { SystemStatus } from '../../types/ui';

// react-i18next is globally mocked in src/test/setup.ts (t(key) => key), so
// buttons render with their i18n key as text.

const status: SystemStatus = {
  version: '4.15.2',
  nodeVersion: 'v24',
  uptime: '1h',
  platform: 'linux',
  architecture: 'x64',
  environment: 'test',
  memoryUsage: { heapUsed: '1 MB', heapTotal: '2 MB', rss: '3 MB' },
} as SystemStatus;

describe('SystemStatusModal — connection controls (#4908)', () => {
  it('shows Disconnect when connected and manageable, and click disconnects + closes', () => {
    const onDisconnect = vi.fn();
    const onClose = vi.fn();
    render(
      <SystemStatusModal
        isOpen
        systemStatus={status}
        onClose={onClose}
        connectionStatus="connected"
        canManageConnection
        onDisconnect={onDisconnect}
      />,
    );
    fireEvent.click(screen.getByText('header.disconnect'));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows Reconnect when user-disconnected', () => {
    const onReconnect = vi.fn();
    render(
      <SystemStatusModal
        isOpen
        systemStatus={status}
        onClose={() => {}}
        connectionStatus="user-disconnected"
        canManageConnection
        onReconnect={onReconnect}
      />,
    );
    fireEvent.click(screen.getByText('header.connect'));
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('header.disconnect')).toBeNull();
  });

  it('shows no connection control without manage permission', () => {
    render(
      <SystemStatusModal
        isOpen
        systemStatus={status}
        onClose={() => {}}
        connectionStatus="connected"
        canManageConnection={false}
        onDisconnect={vi.fn()}
      />,
    );
    expect(screen.queryByText('header.disconnect')).toBeNull();
    expect(screen.queryByText('header.connect')).toBeNull();
  });
});
