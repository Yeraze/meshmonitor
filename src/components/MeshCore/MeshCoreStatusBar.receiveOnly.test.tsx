/**
 * @vitest-environment jsdom
 *
 * MeshCoreStatusBar — receive-only gating (#4547 Phase 2 WP3).
 *
 * Send advert is the SECOND render path for the same action gated in
 * MeshCoreSettingsView (WP2). Disconnect is not RF and must stay enabled.
 * A persistent status chip renders whenever receiveOnly is true, giving an
 * always-visible indicator on the MeshCore page regardless of the global
 * banner.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MeshCoreStatusBar } from './MeshCoreStatusBar';
import type { ConnectionStatus } from './hooks/useMeshCore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

const TOOLTIP = 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.';

function makeActions() {
  return {
    sendAdvert: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

const connectedStatus: ConnectionStatus = {
  connected: true,
  localNode: { publicKey: 'a'.repeat(64), name: 'Local Node' },
} as ConnectionStatus;

describe('MeshCoreStatusBar receive-only mode', () => {
  it('disables Send advert with a tooltip, leaves Disconnect enabled', () => {
    const actions = makeActions();
    render(
      <MeshCoreStatusBar
        status={connectedStatus}
        loading={false}
        onOpenSettings={vi.fn()}
        actions={actions as any}
        receiveOnly
      />,
    );
    const advertBtn = screen.getByText('Send advert').closest('button');
    const disconnectBtn = screen.getByText('Disconnect').closest('button');
    expect(advertBtn).toBeDisabled();
    expect(advertBtn).toHaveAttribute('title', TOOLTIP);
    expect(disconnectBtn).not.toBeDisabled();
  });

  it('renders a persistent receive-only status chip', () => {
    const actions = makeActions();
    render(
      <MeshCoreStatusBar
        status={connectedStatus}
        loading={false}
        onOpenSettings={vi.fn()}
        actions={actions as any}
        receiveOnly
      />,
    );
    expect(screen.getByText('Receive-only')).toBeInTheDocument();
  });

  it('leaves Send advert enabled and untitled, and does not render the chip, when receiveOnly is false', () => {
    const actions = makeActions();
    render(
      <MeshCoreStatusBar
        status={connectedStatus}
        loading={false}
        onOpenSettings={vi.fn()}
        actions={actions as any}
      />,
    );
    const advertBtn = screen.getByText('Send advert').closest('button');
    expect(advertBtn).not.toBeDisabled();
    expect(advertBtn).toHaveAttribute('title', 'Send advert');
    expect(screen.queryByText('Receive-only')).not.toBeInTheDocument();
  });
});
