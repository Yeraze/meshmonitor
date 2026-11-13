/**
 * @vitest-environment jsdom
 *
 * UsersTab — the "Save permissions" request (handleUpdatePermissions).
 *
 * Renders the real UsersTab, loads a user's permissions from a mocked API,
 * clicks Save and checks the PUT payload. Replaces
 * UsersTab.permission-save.test.ts, which re-implemented the filter instead
 * of rendering the component (#6379). The original bug: a hardcoded resource
 * subset silently dropped connection / traceroute / audit on save.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock(undefined, {
    Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
  });
});

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

const showToastMock = vi.fn();
vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const apiGetMock = vi.fn();
const apiPutMock = vi.fn();
vi.mock('../services/api', () => ({
  default: {
    get: (...args: unknown[]) => apiGetMock(...args),
    put: (...args: unknown[]) => apiPutMock(...args),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

import UsersTab from './UsersTab';

type Perm = { read?: boolean; write?: boolean; viewOnMap?: boolean };

function setupApi(opts: { permissions: Record<string, Perm>; sources?: Array<{ id: string; name: string; type: string }> }) {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation(async (url: string) => {
    if (url === '/api/users') {
      return {
        users: [{
          id: 2, username: 'alice', email: null, displayName: 'Alice', authProvider: 'local',
          isAdmin: false, isActive: true, passwordLocked: false, createdAt: 0, lastLoginAt: null,
        }],
      };
    }
    if (url === '/api/channel-database') return { data: [] };
    if (url === '/api/sources') return opts.sources ?? [{ id: 'src-a', name: 'Alpha', type: 'meshtastic_tcp' }];
    if (url.includes('channel-database-permissions')) return { data: [] };
    if (url.includes('/permissions')) return { permissions: opts.permissions };
    if (url.includes('/api/channels/all')) return [{ id: 0, name: '' }];
    return {};
  });
  apiPutMock.mockReset();
  apiPutMock.mockResolvedValue({ success: true });
}

async function openAliceAndSave() {
  render(<UsersTab />);
  fireEvent.click(await screen.findByText(/Alice/));
  // Wait until the user's permissions are loaded before saving.
  await waitFor(() => expect(apiGetMock.mock.calls.some(([u]) => String(u).startsWith('/api/users/2/permissions'))).toBe(true));
  fireEvent.click(await screen.findByText('users.save_permissions'));
  await waitFor(() => expect(apiPutMock).toHaveBeenCalled());
  const [url, body] = apiPutMock.mock.calls[0];
  return { url: url as string, body: body as { permissions: Record<string, Perm>; sourceId?: string } };
}

beforeEach(() => {
  showToastMock.mockReset();
});

describe('UsersTab — save permissions payload', () => {
  it('sends connection, traceroute and audit (the resources the old hardcoded list dropped)', async () => {
    setupApi({
      permissions: {
        connection: { read: true, write: true },
        traceroute: { read: true, write: true },
        audit: { read: true, write: false },
      },
    });
    const { url, body } = await openAliceAndSave();
    expect(url).toBe('/api/users/2/permissions');
    expect(body.permissions.connection).toEqual({ read: true, write: true });
    expect(body.permissions.traceroute).toEqual({ read: true, write: true });
    expect(body.permissions.audit).toEqual({ read: true, write: false });
  });

  it('sends viewOnMap only for channel_* and nodes, and fills missing flags with false', async () => {
    setupApi({
      permissions: {
        nodes: { read: true, viewOnMap: true },
        channel_0: { viewOnMap: true },
        dashboard: { read: true, viewOnMap: true },
        messages: { write: true },
      },
    });
    const { body } = await openAliceAndSave();
    expect(body.permissions.nodes).toEqual({ viewOnMap: true, read: true, write: false });
    expect(body.permissions.channel_0).toEqual({ viewOnMap: true, read: false, write: false });
    expect(body.permissions.dashboard).toEqual({ read: true, write: false });
    expect(body.permissions.messages).toEqual({ read: false, write: true });
  });

  it('includes global (non-sourcey) resources alongside the per-source ones', async () => {
    setupApi({
      permissions: {
        dashboard: { read: true },
        sources: { read: true, write: true },
        themes: { read: true },
      },
    });
    const { body } = await openAliceAndSave();
    expect(body.permissions.sources).toEqual({ read: true, write: true });
    expect(body.permissions.themes).toEqual({ read: true, write: false });
  });

  it('sends remote_admin (a per-source resource once missing from the grid)', async () => {
    setupApi({ permissions: { remote_admin: { read: true, write: true } } });
    const { body } = await openAliceAndSave();
    expect(body.permissions.remote_admin).toEqual({ read: true, write: true });
    expect(body.sourceId).toBe('src-a');
  });

  it('renders a remote_admin row in the per-source grid', async () => {
    setupApi({ permissions: {} });
    render(<UsersTab />);
    fireEvent.click(await screen.findByText(/Alice/));
    const label = await screen.findByTitle(/remote MeshCore nodes/);
    expect(label.className).toBe('permission-label');
  });

  it('does not add viewOnMap to channel_database (only real channel_N slots get it)', async () => {
    setupApi({
      permissions: {
        channel_database: { read: true, write: false },
        channel_1: { read: true, viewOnMap: true },
      },
    });
    const { body } = await openAliceAndSave();
    expect(body.permissions.channel_database).toEqual({ read: true, write: false });
    expect(body.permissions.channel_1).toEqual({ viewOnMap: true, read: true, write: false });
  });

  it('omits resources the user has no entry for, and drops unknown resource keys', async () => {
    setupApi({
      permissions: {
        dashboard: { read: true },
        not_a_real_resource: { read: true, write: true },
      },
    });
    const { body } = await openAliceAndSave();
    expect(Object.keys(body.permissions)).toEqual(['dashboard']);
  });

  it('scopes the save to the selected source', async () => {
    setupApi({ permissions: { dashboard: { read: true } } });
    const { body } = await openAliceAndSave();
    expect(body.sourceId).toBe('src-a');
    expect(showToastMock).toHaveBeenCalledWith('users.permissions_updated', 'success');
  });

  it('shows the insufficient-permissions toast on a 403', async () => {
    setupApi({ permissions: { dashboard: { read: true } } });
    apiPutMock.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    await openAliceAndSave();
    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith('users.insufficient_permissions_update', 'error'),
    );
  });

  it('shows the generic failure toast on other errors', async () => {
    setupApi({ permissions: { dashboard: { read: true } } });
    apiPutMock.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    await openAliceAndSave();
    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith('users.failed_update_permissions', 'error'),
    );
  });
});
