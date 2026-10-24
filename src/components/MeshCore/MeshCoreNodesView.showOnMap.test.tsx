/**
 * @vitest-environment jsdom
 *
 * MeshCoreNodesView — Show on Map hand-off (#5964). A `focusPublicKey`
 * selects the node on the map (which centres on it) and asks the map to open
 * its popup; the map's "handled" callback clears that request while the node
 * stays selected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const mapProps = vi.fn();
vi.mock('./MeshCoreMap', () => ({
  MeshCoreMap: (props: Record<string, unknown>) => {
    mapProps(props);
    return <div data-testid="mc-map" />;
  },
}));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));
vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'test-source', sourceName: 'Test Source', sourceType: 'meshcore' }),
}));
vi.mock('../../hooks/useNodeDisplaySettings', () => ({
  useNodeDisplaySettings: () => ({ maxNodeAgeHours: 24, maxInfraNodeAgeHours: 720 }),
}));

import { MeshCoreNodesView } from './MeshCoreNodesView';
import type { MeshCoreNode } from './hooks/useMeshCore';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

const PK = 'a'.repeat(64);
const nodes: MeshCoreNode[] = [{ publicKey: PK, name: 'Alpha', advType: 2, lastHeard: Date.now() }];
const contacts: MeshCoreContact[] = [{ publicKey: PK, advName: 'Alpha', advType: 2, latitude: 1, longitude: 2 }];
const lastMapProps = () => mapProps.mock.calls.at(-1)![0] as {
  selectedPublicKey: string | null;
  pendingPopupPublicKey: string | null;
  onPendingPopupHandled: () => void;
};

describe('MeshCoreNodesView — Show on Map (#5964)', () => {
  beforeEach(() => mapProps.mockClear());

  it('selects the focused node and asks the map for its popup on the first render', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} focusPublicKey={PK} />);
    const first = mapProps.mock.calls[0][0] as { selectedPublicKey: string; pendingPopupPublicKey: string };
    expect(first.selectedPublicKey).toBe(PK);
    expect(first.pendingPopupPublicKey).toBe(PK);
  });

  it('clears the popup request once the map handles it, keeping the selection', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} focusPublicKey={PK} />);
    act(() => lastMapProps().onPendingPopupHandled());
    expect(lastMapProps().pendingPopupPublicKey).toBeNull();
    expect(lastMapProps().selectedPublicKey).toBe(PK);
  });

  it('selects nothing without a focus key', () => {
    render(<MeshCoreNodesView nodes={nodes} contacts={contacts} />);
    expect(lastMapProps().selectedPublicKey).toBeNull();
    expect(lastMapProps().pendingPopupPublicKey).toBeNull();
  });
});
