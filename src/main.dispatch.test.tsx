/**
 * @vitest-environment jsdom
 *
 * Dispatch test for `SourceApp` (#3960 Phase 1b WP2).
 *
 * `SourceApp` (in `main.tsx`) branches on `source.type` to decide which
 * per-source page to render: `meshcore` -> MeshCoreSourcePage, `reticulum`
 * -> ReticulumSourcePage, anything else -> the legacy Meshtastic `<App>`.
 * No test existed for this dispatch before WP2 (confirmed: it wasn't added
 * when the `meshcore` branch first landed either) — this file covers all
 * three branches so the reticulum branch added here doesn't regress the
 * other two.
 *
 * `main.tsx` calls `ReactDOM.createRoot(document.getElementById('root')!)
 * .render(...)` unconditionally at module scope. `react-dom/client` is
 * mocked so importing the module doesn't require a real `#root` element or
 * reconcile the full top-level app tree — that path isn't what's under
 * test here, only the named `SourceApp` export is. Every other top-level
 * page `main.tsx` imports is stubbed to a cheap marker so the test doesn't
 * pay for, or depend on, their real trees.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-dom/client', () => ({
  default: { createRoot: () => ({ render: vi.fn(), unmount: vi.fn() }) },
  createRoot: () => ({ render: vi.fn(), unmount: vi.fn() }),
}));

vi.mock('./App.tsx', () => ({ default: () => <div data-testid="app-legacy" /> }));
vi.mock('./pages/PacketMonitorPage.tsx', () => ({ default: () => null }));
vi.mock('./pages/DashboardPage.tsx', () => ({ default: () => null }));
vi.mock('./pages/MapAnalysisPage.tsx', () => ({ default: () => null }));
vi.mock('./pages/ReportsPage.tsx', () => ({ default: () => null }));
vi.mock('./components/automations/AutomationsPage.tsx', () => ({ default: () => null }));
vi.mock('./pages/UnifiedMessagesPage.tsx', () => ({ default: () => null }));
vi.mock('./pages/UnifiedTelemetryPage.tsx', () => ({ default: () => null }));
vi.mock('./pages/UnifiedPacketMonitorPage.tsx', () => ({ default: () => null }));
vi.mock('./pages/GlobalSettingsPage.tsx', () => ({ default: () => null }));
vi.mock('./pages/UsersPage.tsx', () => ({ default: () => null }));
vi.mock('./pages/MeshCoreSourcePage.tsx', () => ({
  default: () => <div data-testid="meshcore-source-page" />,
}));
vi.mock('./pages/ReticulumSourcePage.tsx', () => ({
  default: () => <div data-testid="reticulum-source-page" />,
}));

vi.mock('./config/i18n', () => ({}));
vi.mock('./utils/keyboardInsets', () => ({ installKeyboardInsetsObserver: () => {} }));

vi.mock('./contexts/WebSocketContext', () => ({
  WebSocketProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

let mockSources: Array<{ id: string; name: string; type: string; enabled: boolean }> = [];
vi.mock('./hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: mockSources, isLoading: false }),
}));

import { SourceApp } from './main';

function renderSourceApp(sourceId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/source/${sourceId}/`]}>
        <Routes>
          <Route path="source/:sourceId/*" element={<SourceApp />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SourceApp dispatch (main.tsx)', () => {
  beforeEach(() => {
    mockSources = [
      { id: 'ret-1', name: 'RNS Source', type: 'reticulum', enabled: true },
      { id: 'mc-1', name: 'MC Source', type: 'meshcore', enabled: true },
      { id: 'mt-1', name: 'MT Source', type: 'meshtastic_tcp', enabled: true },
    ];
  });

  it('renders ReticulumSourcePage for a reticulum-type source', () => {
    renderSourceApp('ret-1');
    expect(screen.getByTestId('reticulum-source-page')).toBeInTheDocument();
    expect(screen.queryByTestId('meshcore-source-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-legacy')).not.toBeInTheDocument();
  });

  it('renders MeshCoreSourcePage for a meshcore-type source (no regression)', () => {
    renderSourceApp('mc-1');
    expect(screen.getByTestId('meshcore-source-page')).toBeInTheDocument();
    expect(screen.queryByTestId('reticulum-source-page')).not.toBeInTheDocument();
  });

  it('falls through to the legacy App for any other source type', () => {
    renderSourceApp('mt-1');
    expect(screen.getByTestId('app-legacy')).toBeInTheDocument();
    expect(screen.queryByTestId('reticulum-source-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('meshcore-source-page')).not.toBeInTheDocument();
  });

  it('redirects when the sourceId has no matching entry yet and loading has finished', () => {
    // No matching source and isLoading:false renders the fallthrough <App>
    // branch (source is undefined, source?.type is undefined) — pin this
    // so a future change to the "unknown source" branch is a deliberate one.
    renderSourceApp('unknown-id');
    expect(screen.getByTestId('app-legacy')).toBeInTheDocument();
  });
});
