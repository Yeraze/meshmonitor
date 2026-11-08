/**
 * @vitest-environment jsdom
 *
 * MeshCoreContactDetailPanel — collapsible "Link history" (#6262). The shared
 * graph components mount lazily, for the contact's public key and source, with
 * the favorite toggle off.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeshCoreContactDetailPanel } from './MeshCoreContactDetailPanel';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY', telemetryVisualizationHours: 48 }),
}));
vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'test-source', sourceName: 'Test' }),
}));
vi.mock('../../hooks/useResolvedSourceId', () => ({ useResolvedSourceId: () => 'test-source' }));
vi.mock('./MeshCoreRemoteConsole', () => ({ MeshCoreRemoteConsole: () => null }));

const hops = vi.fn();
const quality = vi.fn();
const trend = vi.fn();
vi.mock('../SmartHopsGraphs', () => ({
  default: (p: Record<string, unknown>) => { hops(p); return <div data-testid="hops" />; },
}));
vi.mock('../LinkQualityGraph', () => ({
  default: (p: Record<string, unknown>) => { quality(p); return <div data-testid="quality" />; },
}));
vi.mock('../SignalTrendBadge', () => ({
  default: (p: Record<string, unknown>) => { trend(p); return <div data-testid="trend" />; },
}));

const PK = 'e'.repeat(64);
const CONTACT: MeshCoreContact = { publicKey: PK, advName: 'Hilltop', advType: 2 };

describe('MeshCoreContactDetailPanel — Link history (#6262)', () => {
  it('mounts nothing until opened, then passes key, source and allowFavorite=false', async () => {
    render(<MeshCoreContactDetailPanel contact={CONTACT} publicKey={PK} canWriteNodes={false} isCompanion={false} />);
    expect(screen.queryByTestId('hops')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Link history/ }));

    expect(screen.getByTestId('hops')).toBeTruthy();
    expect(screen.getByTestId('quality')).toBeTruthy();
    expect(screen.getByTestId('trend')).toBeTruthy();
    expect(hops).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: PK, sourceId: 'test-source', allowFavorite: false, telemetryHours: 48,
    }));
    expect(quality).toHaveBeenCalledWith(expect.objectContaining({ nodeId: PK, allowFavorite: false }));
    expect(trend).toHaveBeenCalledWith(expect.objectContaining({ nodeId: PK, sourceId: 'test-source' }));

    await userEvent.click(screen.getByRole('button', { name: /Link history/ }));
    expect(screen.queryByTestId('hops')).toBeNull();
  });
});
