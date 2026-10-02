/**
 * @vitest-environment jsdom
 *
 * Route-shape regression test (#5535 review): the Remote Admin badge must
 * navigate to a route that actually exists. `src/main.tsx` only mounts the
 * Admin Commands tab nested under `source/:sourceId/*` (which renders the
 * legacy `<App>` shell, whose own `<Routes>` declares `path="admin"` —
 * `App.tsx` ~3625); a bare `/admin` falls through to `src/main.tsx`'s
 * top-level `path="*"` (the Dashboard). The first cut of this feature built
 * an absolute `/admin?node=...` path, which every other test in this PR
 * missed because none of them render inside that real nested shape — a
 * `MemoryRouter` with no other routes happily renders a `<Link to="/admin">`
 * without ever telling you it doesn't match anything "real".
 *
 * This test mounts a minimal version of that *real* nesting — a
 * `source/:sourceId/*` route whose element has its own `messages` / `admin`
 * routes, plus a top-level `*` fallback standing in for the Dashboard — and
 * clicks through from the badge to confirm the right route (and the right
 * node) ends up selected, not the fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter, Routes, Route, useParams } from 'react-router-dom';
import NodeDetailsBlock from './NodeDetailsBlock';
import type { DeviceInfo } from '../types/device';

const h = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiSendAdminCommand: vi.fn(),
}));

// Stable `t` (module-level, not rebuilt per render) for both components —
// see the note in AdminCommandsTab.txDisabled.test.tsx: a fresh identity
// loops forever.
vi.mock('react-i18next', () => {
  const t = (_key: string, fallback?: string | Record<string, unknown>) =>
    (typeof fallback === 'string' ? fallback : _key);
  return { useTranslation: () => ({ t }) };
});

// --- NodeDetailsBlock's non-router dependencies ---
vi.mock('../hooks/useServerData', () => ({
  useChannels: () => ({ channels: [] }),
  useDeviceConfig: () => ({ currentNodeId: null }),
}));
vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ nodeHopsCalculation: 'client' }),
}));
vi.mock('../contexts/MapContext', () => ({
  useMapContext: () => ({ traceroutes: [] }),
}));
vi.mock('./NodeDetailsBlock.css', () => ({}));

// --- AdminCommandsTab's non-router dependencies (mirrors
// AdminCommandsTab.deepLink.test.tsx) ---
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../hooks/useResolvedSourceId', () => ({ useResolvedSourceId: () => 'src-1' }));
vi.mock('../hooks/useTxStatus', () => ({ useTxStatus: () => ({ isTxDisabled: false }) }));
vi.mock('../services/api', () => ({
  default: {
    setBaseUrl: vi.fn(),
    post: h.apiPost,
    sendAdminCommand: h.apiSendAdminCommand,
    exportChannel: vi.fn(),
    importChannel: vi.fn(),
    getAllChannels: vi.fn().mockResolvedValue([]),
    // #4110 signal-trend badge: NodeDetailsBlock fetches this once a sourceId
    // is present. Resolve to null (no trend) -- the badge itself isn't what
    // this test is about.
    getSignalTrend: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('./SectionNav', () => ({ default: () => null }));
vi.mock('./configuration/ImportConfigModal', () => ({ ImportConfigModal: () => null }));
vi.mock('./configuration/ExportConfigModal', () => ({ ExportConfigModal: () => null }));
vi.mock('./admin-commands/ModuleConfigurationSection', () => ({ ModuleConfigurationSection: () => null }));
vi.mock('./admin-commands/AutoFavoriteManagementSection', () => ({ default: () => null }));
vi.mock('./admin-commands/DeviceConfigurationSection', () => ({ DeviceConfigurationSection: () => null }));

import AdminCommandsTab from './AdminCommandsTab';

const LOCAL_NODE_ID = '!00000064';
const localNode = {
  nodeNum: 100,
  user: { id: LOCAL_NODE_ID, longName: 'Local Node', shortName: 'LOC1' },
};
const remoteNode = {
  nodeNum: 200,
  user: { id: '!000000c8', longName: 'Remote Node', shortName: 'REM1' },
  hasRemoteAdmin: true,
  lastRemoteAdminCheck: Date.now(),
};

const remoteDeviceInfo: DeviceInfo = {
  nodeNum: remoteNode.nodeNum,
  user: { ...remoteNode.user, role: 'CLIENT' },
  hasRemoteAdmin: true,
  lastRemoteAdminCheck: remoteNode.lastRemoteAdminCheck,
};

/** Stands in for `App.tsx`'s own `<Routes>` under `source/:sourceId/*`. */
function SourceShell() {
  const { sourceId } = useParams<{ sourceId: string }>();
  return (
    <Routes>
      <Route
        path="messages"
        element={<NodeDetailsBlock node={remoteDeviceInfo} sourceId={sourceId} canOpenRemoteAdmin />}
      />
      <Route
        path="admin"
        element={<AdminCommandsTab nodes={[localNode, remoteNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />}
      />
    </Routes>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.apiPost.mockResolvedValue({});
  h.apiSendAdminCommand.mockResolvedValue({});
  // `BrowserRouter` (not `MemoryRouter`) deliberately: `AdminCommandsTab`
  // reads `window.location.search` directly, and `MemoryRouter` keeps its
  // own in-memory history that never touches the real `window.location` --
  // a click there would route correctly but silently fail to prove the
  // `?node=` param actually survives a real client-side navigation.
  // `BrowserRouter` uses the History API for real, same as `src/main.tsx`.
  window.history.pushState({}, '', '/source/src-1/messages');
});

describe('Remote Admin badge — real nested route shape (#5535 review)', () => {
  it('navigates from the node-details badge to the nested Admin Commands route with the node pre-selected, not the Dashboard fallback', async () => {
    render(
      <BrowserRouter>
        <Routes>
          <Route path="source/:sourceId/*" element={<SourceShell />} />
          {/* Stands in for src/main.tsx's top-level `path="*"` -> DashboardPage.
              A `/admin` (bare, not nested) lands here instead of on the real
              admin route -- this is exactly the bug under test. */}
          <Route path="*" element={<div data-testid="dashboard-fallback">DASHBOARD</div>} />
        </Routes>
      </BrowserRouter>,
    );

    const link = screen.getByRole('link', { name: /open remote admin/i });
    fireEvent.click(link);

    // Must NOT have fallen through to the Dashboard route.
    expect(screen.queryByTestId('dashboard-fallback')).not.toBeInTheDocument();

    // Must have landed on the real nested Admin Commands tab, with the
    // linked node already selected (a fresh mount reading the just-updated
    // `window.location.search` after the real client-side navigation above,
    // not a stale value cached before the click).
    const input = await screen.findByPlaceholderText('Remote Node');
    expect(input).toHaveValue('Remote Node');
    expect(window.location.pathname).toBe('/source/src-1/admin');
    expect(window.location.search).toBe('?node=%21000000c8');
  });
});
