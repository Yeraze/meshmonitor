/**
 * @vitest-environment jsdom
 *
 * UsersTab — settings-is-sourcey grouping proof (#4416)
 *
 * PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md §5.1 / §7 WP4: `settings` moving
 * from GLOBAL_PERMISSION_RESOURCES to the per-source grid is expected to be
 * a ZERO production-code change, because both sections are already derived
 * from `SOURCEY_RESOURCES` (`src/types/permission.ts`) rather than hardcoded
 * here:
 *   - Global section:  GLOBAL_PERMISSION_RESOURCES = RESOURCES.filter(r =>
 *     !SOURCEY_RESOURCES.includes(r.id))                      (UsersTab.tsx)
 *   - Per-source grid: PERMISSION_KEYS.filter(r =>
 *     SOURCEY_RESOURCES.includes(r as ResourceType))          (UsersTab.tsx)
 *
 * This file exists to PROVE that derivation still holds after WP1 added
 * 'settings' to SOURCEY_RESOURCES, not to change UsersTab.tsx. See the
 * bottom of this file for the negative control that was run (and observed
 * failing) against a reverted SOURCEY_RESOURCES list.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

// --- mocks (mirrors UsersTab.test.tsx) ------------------------------------

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, vars?: Record<string, unknown>) => {
      if (typeof fallback === 'string') {
        if (vars && typeof vars === 'object') {
          return fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => String((vars as any)[k] ?? ''));
        }
        return fallback;
      }
      return key;
    },
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    authStatus: {
      authenticated: true,
      user: { id: 1, username: 'admin', isAdmin: true },
      permissions: { global: {}, bySource: {} },
      channelDbPermissions: {},
    },
  }),
}));

vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const apiGetMock = vi.fn();
const apiPutMock = vi.fn();
const apiPostMock = vi.fn();
const apiDeleteMock = vi.fn();
vi.mock('../services/api', () => ({
  default: {
    get: (...args: unknown[]) => apiGetMock(...args),
    put: (...args: unknown[]) => apiPutMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
    delete: (...args: unknown[]) => apiDeleteMock(...args),
  },
}));

import UsersTab from './UsersTab';

function setupApi(opts: {
  permissions?: Record<string, { read?: boolean; write?: boolean; viewOnMap?: boolean }>;
} = {}) {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation(async (url: string) => {
    if (url === '/api/users') {
      return {
        users: [
          {
            id: 2,
            username: 'alice',
            email: null,
            displayName: 'Alice',
            authProvider: 'local',
            isAdmin: false,
            isActive: true,
            passwordLocked: false,
            createdAt: 0,
            lastLoginAt: null,
          },
        ],
      };
    }
    if (url === '/api/channel-database') {
      return { data: [] };
    }
    if (url === '/api/sources') {
      return [{ id: 'src-a', name: 'Alpha', type: 'meshtastic_tcp' }];
    }
    if (url.includes('/permissions') && !url.includes('channel-database')) {
      return { permissions: opts.permissions ?? {} };
    }
    if (url.includes('channel-database-permissions')) {
      return { data: [] };
    }
    if (url.includes('/api/channels/all')) {
      return [{ id: 0, name: '' }];
    }
    return {};
  });
  apiPutMock.mockReset();
  apiPutMock.mockResolvedValue({ success: true });
}

beforeEach(() => {
  setupApi();
});

describe('UsersTab — settings-is-sourcey grouping (#4416)', () => {
  it('with a source scope selected, settings appears in the per-source grid and NOT in Global Resources', async () => {
    const { container } = render(<UsersTab />);
    fireEvent.click(await screen.findByText(/Alice/));

    // Confirm a source scope is actually selected (auto-selected from the
    // single fixture source) — otherwise the per-source grid wouldn't
    // render at all and the "absence" assertion below would be meaningless.
    await waitFor(() => expect(screen.getByLabelText(/permission_scope/i)).toBeInTheDocument());
    const select = screen.getByLabelText(/permission_scope/i) as HTMLSelectElement;
    expect(select.value).toBe('src-a');

    await waitFor(() => expect(screen.getByText('Global Resources')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Per-Source Resources')).toBeInTheDocument());

    // With channelDatabaseEntries empty (fixture default), there are exactly
    // two `.permissions-grid` elements in DOM order: the Global Resources
    // grid (rendered first, ~UsersTab.tsx:825), then the per-source grid
    // (~UsersTab.tsx:943). Grabbing them positionally is more robust than
    // DOM-tree-shape assumptions about sibling/parent structure.
    const grids = container.querySelectorAll('.permissions-grid');
    expect(grids.length).toBe(2);
    const [globalGrid, perSourceGrid] = Array.from(grids) as HTMLElement[];

    // `settings` label text is t('nav.settings') → the mocked t() with no
    // fallback returns the raw key 'nav.settings' (not the resource key
    // 'settings' itself — see the second assertion in this test).
    expect(within(perSourceGrid).getByText('nav.settings')).toBeInTheDocument();

    // And it must NOT appear in the Global Resources section.
    expect(within(globalGrid).queryByText('nav.settings')).not.toBeInTheDocument();
  });

  it("settings' label comes from labelMap ('nav.settings'), not the raw key 'settings'", async () => {
    render(<UsersTab />);
    fireEvent.click(await screen.findByText(/Alice/));
    await waitFor(() => expect(screen.getByText('Per-Source Resources')).toBeInTheDocument());

    // The raw resource key must never leak into the UI as a label — every
    // other row is translated/humanized (e.g. "Node Map & List", not
    // "nodes"). Assert the untranslated literal 'settings' does not appear
    // as its own text node anywhere.
    expect(screen.queryByText('settings', { selector: '.permission-label' })).not.toBeInTheDocument();
    expect(screen.getByText('nav.settings')).toBeInTheDocument();
  });

  it('Global Resources section still contains themes / sources / channel_database (control: section is visible and populated)', async () => {
    render(<UsersTab />);
    fireEvent.click(await screen.findByText(/Alice/));
    await waitFor(() => expect(screen.getByText('Global Resources')).toBeInTheDocument());

    // Proves the settings-absence assertion above is meaningful — if the
    // Global Resources section itself failed to render, "settings absent
    // from it" would be true for the wrong reason.
    expect(screen.getByText('Custom Themes')).toBeInTheDocument();
    expect(screen.getByText('Sources')).toBeInTheDocument();
    expect(screen.getByText('Channel Database')).toBeInTheDocument();
  });
});

/**
 * NEGATIVE CONTROL (observed, not committed as a test):
 *
 * With `'settings'` removed from `SOURCEY_RESOURCES` in
 * src/types/permission.ts (reverting WP1's one-line change), this file's
 * first two tests fail on BOTH assertions:
 *   - 'nav.settings' is absent from the per-source grid
 *     (`within(perSourceGrid).getByText('nav.settings')` throws)
 *   - 'nav.settings' is present in the Global Resources section instead
 *     (`within(globalGrid).queryByText('nav.settings')` is non-null)
 * confirming the test is not half-blind. See the WP4 report for the pasted
 * failure output.
 */
