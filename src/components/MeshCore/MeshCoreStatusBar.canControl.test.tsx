/**
 * @vitest-environment jsdom
 *
 * MeshCoreStatusBar — control gating (#6524).
 *
 * Advert, Flood advert, Disconnect and Connect all call routes that require a
 * signed-in user with `connection:write`. A viewer without that grant (an
 * anonymous guest, or a read-only user) must not see them.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MeshCoreStatusBar } from './MeshCoreStatusBar';
import type { ConnectionStatus } from './hooks/useMeshCore';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const t = (key: string, fallback?: string | Record<string, unknown>) => {
    if (typeof fallback === 'string') return fallback;
    return key;
  };
  return createReactI18nextMock(t);
});

const actions = {
  sendAdvert: vi.fn().mockResolvedValue(true),
  disconnect: vi.fn().mockResolvedValue(undefined),
};

const connectedStatus = {
  connected: true,
  localNode: { publicKey: 'a'.repeat(64), name: 'Local Node' },
} as ConnectionStatus;

const disconnectedStatus = { connected: false } as ConnectionStatus;

const CONTROL_LABELS = ['Advert (nearby, zero-hop)', 'Flood advert', 'Disconnect'];

describe('MeshCoreStatusBar control gating', () => {
  it('hides advert and disconnect buttons when the viewer cannot control the source', () => {
    render(
      <MeshCoreStatusBar
        status={connectedStatus}
        loading={false}
        onOpenSettings={vi.fn()}
        actions={actions as any}
        canControl={false}
      />,
    );
    for (const label of CONTROL_LABELS) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    // The connection status itself is still shown.
    expect(screen.getByText('meshcore.connected_to')).toBeInTheDocument();
  });

  it('hides the Connect button when the viewer cannot control the source', () => {
    render(
      <MeshCoreStatusBar
        status={disconnectedStatus}
        loading={false}
        onOpenSettings={vi.fn()}
        actions={actions as any}
        canControl={false}
      />,
    );
    expect(screen.queryByText('Connect')).not.toBeInTheDocument();
  });

  it('shows the controls when the viewer can control the source', () => {
    render(
      <MeshCoreStatusBar
        status={connectedStatus}
        loading={false}
        onOpenSettings={vi.fn()}
        actions={actions as any}
        canControl
      />,
    );
    for (const label of CONTROL_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
