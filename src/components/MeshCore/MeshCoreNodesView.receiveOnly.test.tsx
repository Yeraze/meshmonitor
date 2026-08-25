/**
 * @vitest-environment jsdom
 *
 * MeshCoreNodesView — the Discover menu is the second render path for
 * discover-nodes (#4547 Phase 2 WP3 §3.5): the same three actions also live
 * in MeshCoreSettingsView (WP2). Missing this half is exactly the class of
 * bug that cost the Meshtastic TX-disabled epic (#4294) a follow-up patch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

vi.mock('./MeshCoreMap', () => ({
  MeshCoreMap: () => <div data-testid="mc-map" />,
}));

const showToast = vi.fn();
vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast }),
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

const TOOLTIP = 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.';

describe('MeshCoreNodesView receive-only mode', () => {
  beforeEach(() => {
    showToast.mockReset();
  });

  it('disables all three discover menu items with a tooltip, and clicking one does not call onDiscoverNodes', () => {
    const onDiscoverNodes = vi.fn().mockResolvedValue({ returned: 2, newCount: 1 });
    render(
      <MeshCoreNodesView
        nodes={[]}
        contacts={[]}
        onDiscoverNodes={onDiscoverNodes}
        canDiscover
        receiveOnly
      />,
    );
    fireEvent.click(screen.getByText('Discover'));

    for (const label of ['Discover Nearby Nodes', 'Discover Repeaters', 'Discover Sensors']) {
      const item = screen.getByRole('menuitem', { name: label });
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute('title', TOOLTIP);
      fireEvent.click(item);
    }
    expect(onDiscoverNodes).not.toHaveBeenCalled();
  });

  it('leaves the discover menu items enabled and untitled when receiveOnly is false', () => {
    const onDiscoverNodes = vi.fn().mockResolvedValue({ returned: 0, newCount: 0 });
    render(
      <MeshCoreNodesView
        nodes={[]}
        contacts={[]}
        onDiscoverNodes={onDiscoverNodes}
        canDiscover
      />,
    );
    fireEvent.click(screen.getByText('Discover'));
    const item = screen.getByRole('menuitem', { name: 'Discover Nearby Nodes' });
    expect(item).not.toBeDisabled();
    expect(item).not.toHaveAttribute('title');

    fireEvent.click(item);
    expect(onDiscoverNodes).toHaveBeenCalledWith('nearby');
  });
});
