/**
 * @vitest-environment jsdom
 *
 * MeshCoreContactDetailPanel — receive-only gating (#4547 Phase 2 WP3).
 *
 * Six of the panel's action buttons transmit (Reset path, Share, Trace,
 * Ping, Discover path, Neighbours — the last a GET that still transmits).
 * Export and Remove are serial/local-DB operations and must stay enabled.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MeshCoreContactDetailPanel } from './MeshCoreContactDetailPanel';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'test-source', sourceName: 'Test' }),
}));

vi.mock('./MeshCoreRemoteConsole', () => ({
  MeshCoreRemoteConsole: () => null,
}));

const PK = 'a'.repeat(64);
const TOOLTIP = 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.';

function renderPanel(receiveOnly: boolean) {
  const contact: MeshCoreContact = {
    publicKey: PK,
    advName: 'Repeater One',
    advType: 2,
    pathLen: 2,
    outPath: 'a3,7f',
  };
  return render(
    <MeshCoreContactDetailPanel
      contact={contact}
      publicKey={PK}
      onResetPath={vi.fn().mockResolvedValue(true)}
      onShareContact={vi.fn().mockResolvedValue({ ok: true })}
      onTracePath={vi.fn().mockResolvedValue({ hops: [], lastSnr: 0 })}
      onPingZeroHop={vi.fn().mockResolvedValue({ ok: true, rttMs: 1, snrToTarget: 1, snrFromTarget: 1 })}
      onDiscoverPath={vi.fn().mockResolvedValue(true)}
      onGetNeighbours={vi.fn().mockResolvedValue({ total: 0, neighbours: [] })}
      onRemoveContact={vi.fn().mockResolvedValue(true)}
      onExportContact={vi.fn().mockResolvedValue([1, 2, 3])}
      canWriteNodes
      isCompanion
      receiveOnly={receiveOnly}
    />,
  );
}

describe('MeshCoreContactDetailPanel receive-only mode', () => {
  it('disables the six RF action buttons with a tooltip', () => {
    renderPanel(true);
    for (const name of [
      'Reset Path', 'Share Contact', 'Trace Path', 'Ping (0 hop)', 'Discover Path', 'Neighbours',
    ]) {
      const btn = screen.getByRole('button', { name });
      expect(btn, `${name} should be disabled`).toBeDisabled();
      expect(btn, `${name} should carry the receive-only tooltip`).toHaveAttribute('title', TOOLTIP);
    }
  });

  it('leaves Export and Remove enabled (serial/local-DB operations)', () => {
    renderPanel(true);
    const exportBtn = screen.getByRole('button', { name: 'Export' });
    const removeBtn = screen.getByRole('button', { name: 'Remove' });
    expect(exportBtn).not.toBeDisabled();
    expect(removeBtn).not.toBeDisabled();
  });

  it('leaves all six RF buttons enabled and untitled when receiveOnly is false', () => {
    renderPanel(false);
    for (const name of [
      'Reset Path', 'Share Contact', 'Trace Path', 'Discover Path', 'Neighbours',
    ]) {
      const btn = screen.getByRole('button', { name });
      expect(btn).not.toBeDisabled();
      expect(btn).not.toHaveAttribute('title', TOOLTIP);
    }
    // The Ping button carries its own explanatory hint when not receive-only
    // — assert only that it's enabled and the tooltip is not the RO one.
    const pingBtn = screen.getByRole('button', { name: 'Ping (0 hop)' });
    expect(pingBtn).not.toBeDisabled();
    expect(pingBtn).not.toHaveAttribute('title', TOOLTIP);
  });
});
