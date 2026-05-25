/**
 * @vitest-environment jsdom
 *
 * PR-C: UsersTab gains
 *  - Global Resources section (themes/sources/channel_database)
 *  - canWrite column on channel-database per-entry permissions
 *  - source dropdown grouped by type via <optgroup>
 *  - 'waypoints' added to PERMISSION_KEYS
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// --- mocks ---------------------------------------------------------------

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

// API mock — return the data each call site under test reads.
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

// Mirror the same response shape /api/users/:id/permissions returns: the
// backend merges global + per-source into a single PermissionSet map.
function setupApi(opts: {
  permissions?: Record<string, { read?: boolean; write?: boolean; viewOnMap?: boolean }>;
  channelDbPermissions?: Array<{ channelDatabaseId: number; canViewOnMap: boolean; canRead: boolean; canWrite?: boolean }>;
  channelDbEntries?: Array<{ id: number; name: string; description: string | null; isEnabled: boolean }>;
  sources?: Array<{ id: string; name: string; type: string }>;
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
      return { data: opts.channelDbEntries ?? [] };
    }
    if (url === '/api/sources') {
      return opts.sources ?? [{ id: 'src-a', name: 'Alpha', type: 'meshtastic_tcp' }];
    }
    if (url.includes('/permissions') && !url.includes('channel-database')) {
      return { permissions: opts.permissions ?? {} };
    }
    if (url.includes('channel-database-permissions')) {
      return { data: opts.channelDbPermissions ?? [] };
    }
    if (url.includes('/api/channels/all')) {
      // Default fixture: a single primary channel — required for the
      // per-source permission grid to render the channel_0 row at all
      // now that the grid is gated on actually-configured channels
      // (fix/users-perm-source-aware-channels). Specific tests can
      // override via `opts.channels`.
      return opts.channels ?? [{ id: 0, name: '' }];
    }
    return {};
  });
  apiPutMock.mockReset();
  apiPutMock.mockResolvedValue({ success: true });
}

beforeEach(() => {
  setupApi();
});

describe('UsersTab — PR-C grid additions', () => {
  it('renders the Global Resources section header above the per-source grid', async () => {
    setupApi({
      channelDbEntries: [],
      sources: [{ id: 'src-a', name: 'Alpha', type: 'meshtastic_tcp' }],
    });
    render(<UsersTab />);

    // Pick the user, which loads permissions and renders the grids.
    const aliceRow = await screen.findByText(/Alice/);
    fireEvent.click(aliceRow);

    await waitFor(() => {
      expect(screen.getByText('Global Resources')).toBeInTheDocument();
      expect(screen.getByText('Per-Source Resources')).toBeInTheDocument();
    });

    // channel_database is one of the new globals — must appear in the
    // Global Resources section.
    expect(screen.getByText('Channel Database')).toBeInTheDocument();
    expect(screen.getByText('Custom Themes')).toBeInTheDocument();
    expect(screen.getByText('Sources')).toBeInTheDocument();
  });

  it('per-source grid does NOT render global resources (themes/sources/channel_database)', async () => {
    setupApi({});
    render(<UsersTab />);
    const aliceRow = await screen.findByText(/Alice/);
    fireEvent.click(aliceRow);
    await waitFor(() => expect(screen.getByText('Per-Source Resources')).toBeInTheDocument());

    // The per-source grid only contains sourcey resources — themes/sources/
    // channel_database labels appear at most once (in the Global Resources
    // section). Count "Sources" occurrences: only one expected.
    const sourcesLabels = screen.getAllByText('Sources');
    expect(sourcesLabels).toHaveLength(1);
  });

  it('source select element uses <optgroup> to group sources by type', async () => {
    setupApi({
      sources: [
        { id: 'tcp-1', name: 'TCP Source', type: 'meshtastic_tcp' },
        { id: 'mqtt-1', name: 'MQTT Broker', type: 'mqtt_broker' },
        { id: 'mc-1', name: 'MeshCore', type: 'meshcore' },
      ],
    });
    render(<UsersTab />);
    const aliceRow = await screen.findByText(/Alice/);
    fireEvent.click(aliceRow);
    await waitFor(() => expect(screen.getByLabelText(/permission_scope/i)).toBeInTheDocument());

    const select = screen.getByLabelText(/permission_scope/i) as HTMLSelectElement;
    const optgroups = select.querySelectorAll('optgroup');
    expect(optgroups.length).toBeGreaterThan(0);
    const labels = Array.from(optgroups).map(g => g.getAttribute('label'));
    // Each present type gets its own group label.
    expect(labels).toEqual(expect.arrayContaining([
      expect.stringMatching(/Meshtastic/),
      expect.stringMatching(/MQTT Broker/),
      expect.stringMatching(/MeshCore/),
    ]));
  });

  it('hides per-slot channel rows and shows a hint when an MQTT source is selected', async () => {
    // For MQTT sources, the slot index in `packet.channel` is the sender's
    // device slot, not a stable channel identity — so channel_0..7 grants
    // don't actually protect a specific channel. Permissions are routed
    // through channel_database_permissions instead. The UI hides the slot
    // grid here and points admins at the Virtual Channel section.
    setupApi({
      sources: [
        { id: 'tcp-1', name: 'TCP Source', type: 'meshtastic_tcp' },
        { id: 'mqtt-1', name: 'MQTT Broker', type: 'mqtt_broker' },
      ],
    });
    render(<UsersTab />);
    const aliceRow = await screen.findByText(/Alice/);
    fireEvent.click(aliceRow);

    const select = (await screen.findByLabelText(/permission_scope/i)) as HTMLSelectElement;

    // TCP source first — channel rows ARE rendered (control case).
    fireEvent.change(select, { target: { value: 'tcp-1' } });
    await waitFor(() => expect(screen.getByText('users.channel_primary')).toBeInTheDocument());
    expect(screen.queryByText(/Virtual Channel Permissions below/i)).not.toBeInTheDocument();

    // Switch to MQTT — channel rows go away, hint appears.
    fireEvent.change(select, { target: { value: 'mqtt-1' } });
    await waitFor(() =>
      expect(screen.getByText(/Virtual Channel Permissions below/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText('users.channel_primary')).not.toBeInTheDocument();
    expect(screen.queryByText('users.channel_n')).not.toBeInTheDocument();
  });

  it('renders channel rows only for channels actually configured on the scoped source', async () => {
    // Regression for issue: UsersTab used to paint all 8 channel_N rows
    // unconditionally, so MeshCore sources (which have no per-slot
    // channels) and Meshtastic sources with fewer than 8 channels showed
    // empty/non-existent rows — e.g. "Channel 1 (Gauntlet)" lingered even
    // after the underlying channel was disabled. The grid is now gated on
    // the source's actual channel list returned by `/api/channels/all`.
    setupApi({
      sources: [
        { id: 'tcp-1', name: 'TCP Source', type: 'meshtastic_tcp' },
      ],
      channels: [
        { id: 0, name: '' }, // Primary, unnamed
        { id: 2, name: 'Gauntlet' }, // configured secondary
      ],
    });
    render(<UsersTab />);
    fireEvent.click(await screen.findByText(/Alice/));
    const select = (await screen.findByLabelText(/permission_scope/i)) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'tcp-1' } });

    // channel_0 (primary, no name) → row appears.
    await waitFor(() => expect(screen.getByText('users.channel_primary')).toBeInTheDocument());
    // channel_2 → row appears, labelled with the channel name.
    expect(screen.getByText(/Gauntlet/)).toBeInTheDocument();
    // channel_1 / channel_3..7 → NOT configured, so no row should render.
    // We assert by counting the channel_n label occurrences — should match
    // exactly one channel (channel_2 here, since channel_0 uses the
    // separate channel_primary key).
    const channelNRows = screen.queryAllByText(/^users\.channel_n/);
    expect(channelNRows).toHaveLength(1);
  });

  it('channel-database section renders a canWrite checkbox column', async () => {
    setupApi({
      channelDbEntries: [
        { id: 11, name: 'Library Net', description: 'Test net', isEnabled: true },
      ],
      channelDbPermissions: [
        { channelDatabaseId: 11, canViewOnMap: false, canRead: true, canWrite: false },
      ],
    });
    render(<UsersTab />);
    const aliceRow = await screen.findByText(/Alice/);
    fireEvent.click(aliceRow);
    await waitFor(() => expect(screen.getByText('Library Net')).toBeInTheDocument());

    // Per-entry row has three checkboxes now: viewOnMap, read, write.
    const row = screen.getByText('Library Net').closest('.permission-item');
    expect(row).not.toBeNull();
    const inputs = row!.querySelectorAll('input[type="checkbox"]');
    expect(inputs.length).toBe(3);

    // Toggling the last (write) checkbox flips the local state — and the
    // disabled state of the read checkbox stays consistent (read is
    // required when write is on).
    const writeCheckbox = inputs[2] as HTMLInputElement;
    expect(writeCheckbox.checked).toBe(false);
    fireEvent.click(writeCheckbox);
    expect(writeCheckbox.checked).toBe(true);
  });
});
