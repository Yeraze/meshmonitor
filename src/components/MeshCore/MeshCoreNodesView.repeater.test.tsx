/**
 * @vitest-environment jsdom
 *
 * MeshCoreNodesView — Repeater source empty state (#5500). A repeater only
 * reports its direct (zero-hop) repeater neighbours, so its empty list says so.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const t = (key: string, fallback?: string | Record<string, unknown>) => {
    if (typeof fallback === 'string') return fallback;
    return key;
  };
  return createReactI18nextMock(t);
});

vi.mock('./MeshCoreMap', () => ({
  MeshCoreMap: () => <div data-testid="mc-map" />,
}));

vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'test-source', sourceName: 'Test Source', sourceType: 'meshcore' }),
}));

vi.mock('../../hooks/useNodeDisplaySettings', () => ({
  useNodeDisplaySettings: () => ({ maxNodeAgeHours: null }),
}));

import { MeshCoreNodesView } from './MeshCoreNodesView';


describe('MeshCoreNodesView — Repeater source empty state (#5500)', () => {
  it('explains that a repeater only reports its zero-hop repeater neighbours', () => {
    render(<MeshCoreNodesView nodes={[]} contacts={[]} isRepeaterSource />);
    expect(screen.getByText(/reports its direct \(zero-hop\) repeater neighbours/)).toBeInTheDocument();
    expect(screen.queryByText('No nodes seen yet')).not.toBeInTheDocument();
  });

  it('keeps the generic empty state for other sources', () => {
    render(<MeshCoreNodesView nodes={[]} contacts={[]} />);
    expect(screen.getByText('No nodes seen yet')).toBeInTheDocument();
    expect(screen.queryByText(/zero-hop/)).not.toBeInTheDocument();
  });

  it('tags only nodes the neighbours table listed, not advert-only nodes (#5553)', () => {
    const nodes = [
      { publicKey: 'aa'.repeat(32), name: 'Near', advType: 1, lastHeard: Date.now(), repeaterNeighborAt: 1_790_000_000_000 },
      { publicKey: 'bb'.repeat(32), name: 'Far', advType: 1, lastHeard: Date.now() },
    ];
    render(<MeshCoreNodesView nodes={nodes} contacts={[]} isRepeaterSource />);
    expect(screen.getByText('Near')).toBeInTheDocument();
    expect(screen.getByText('Far')).toBeInTheDocument();
    expect(screen.getAllByText('Neighbour')).toHaveLength(1);
  });

  it('shows no neighbour tag on a non-repeater source', () => {
    const nodes = [{ publicKey: 'aa'.repeat(32), name: 'Near', advType: 1, lastHeard: Date.now(), repeaterNeighborAt: 1_790_000_000_000 }];
    render(<MeshCoreNodesView nodes={nodes} contacts={[]} />);
    expect(screen.getByText('Near')).toBeInTheDocument();
    expect(screen.queryByText('Neighbour')).not.toBeInTheDocument();
  });
});
