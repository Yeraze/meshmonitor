/**
 * @vitest-environment jsdom
 *
 * Device backup section (#3711 source scoping, #4926 restore, #6285 per-source
 * and protocol-aware): every call carries the section's sourceId, the restore
 * confirm dialog shows the server's no-secret summary, and create/restore are
 * disabled while the radio is offline.
 *
 * #3962 Task 5.5: requests go through apiService, so these tests assert on the
 * apiService mocks' call arguments.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// --- mocks ---------------------------------------------------------------

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const mockShowToast = vi.hoisted(() => vi.fn());
vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// The mock ApiError class is declared inside the factory (not hoisted from
// module scope) since vi.mock factories only get hoisting exemptions for
// `mock`-prefixed bindings.
vi.mock('../../services/api', () => {
  class MockApiError extends Error {
    status: number;
    body?: unknown;
    constructor(message: string, status: number, options?: { body?: unknown }) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = options?.body;
    }
  }

  return {
    ApiError: MockApiError,
    default: {
      getBaseUrl: vi.fn().mockResolvedValue('http://test'),
      get: vi.fn(),
      getText: vi.fn().mockResolvedValue('yaml'),
      download: vi.fn().mockResolvedValue(undefined),
      post: vi.fn().mockResolvedValue({ data: { applied: [], failed: [], channels: 0, requiresReboot: true } }),
      delete: vi.fn().mockResolvedValue({ success: true }),
    },
  };
});

// sourceId is configurable per-test via this mutable holder.
const sourceState: { sourceId: string | null; sourceName: string | null } = {
  sourceId: null,
  sourceName: null,
};
vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => sourceState,
}));

const authState = vi.hoisted(() => ({ isAdmin: false }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ authStatus: { user: { isAdmin: authState.isAdmin } } }),
}));

import apiService from '../../services/api';
import BackupManagementSection from './BackupManagementSection';

const asMock = <T,>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const SETTINGS = { enabled: false, maxBackups: 7, backupTime: '02:00' };

const summaryFor = (over: Record<string, unknown> = {}) => ({
  data: {
    protocol: 'meshtastic',
    name: 'Alpha',
    radio: { region: 'US' },
    channels: [],
    sections: ['owner'],
    requiresReboot: true,
    legacy: false,
    ...over,
  },
});

let list: Array<Record<string, unknown>>;
let summary: ReturnType<typeof summaryFor>;

beforeEach(() => {
  sourceState.sourceId = null;
  sourceState.sourceName = null;
  authState.isAdmin = false;
  vi.clearAllMocks();
  list = [{ filename: 'backup_2026.yaml', timestamp: '2026-08-25T00:00:00Z', size: 100, type: 'manual' }];
  summary = summaryFor();
  asMock(apiService.get).mockImplementation((url: string) => {
    if (url.includes('/api/backup/list')) return Promise.resolve(list);
    if (url.includes('/api/backup/summary')) return Promise.resolve(summary);
    return Promise.resolve(SETTINGS);
  });
  asMock(apiService.download).mockResolvedValue(undefined);
  asMock(apiService.post).mockResolvedValue({ data: { applied: ['config.lora'], failed: [], channels: 0, requiresReboot: true } });
  asMock(apiService.delete).mockResolvedValue({ success: true });
  asMock(apiService.getText).mockResolvedValue('yaml');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

async function openBackupList(ui: React.ReactElement = <BackupManagementSection />) {
  const view = render(ui);
  fireEvent.click(screen.getByText('backup_management.show_backups'));
  await waitFor(() => expect(screen.getByText('backup_2026.yaml')).toBeTruthy());
  return view;
}

describe('source scoping (issue #3711)', () => {
  it('includes sourceId in the manual backup request when a source is selected', async () => {
    sourceState.sourceId = 'src-b';
    render(<BackupManagementSection />);
    fireEvent.click(screen.getByText('backup_management.create_button'));
    await waitFor(() => expect(apiService.download).toHaveBeenCalled());
    const [endpoint] = asMock(apiService.download).mock.calls[0];
    expect(endpoint).toContain('/api/device/backup');
    expect(endpoint).toContain('sourceId=src-b');
  });

  it('omits sourceId when no source is selected (single-source fallback)', async () => {
    render(<BackupManagementSection />);
    fireEvent.click(screen.getByText('backup_management.create_button'));
    await waitFor(() => expect(apiService.download).toHaveBeenCalled());
    const [endpoint] = asMock(apiService.download).mock.calls[0];
    expect(endpoint).toContain('/api/device/backup');
    expect(endpoint).not.toContain('sourceId=');
  });

  it('every call carries the sourceId prop: settings, save, list, download, summary, restore, delete', async () => {
    render(<BackupManagementSection sourceId="src-z" />);
    // settings load
    await waitFor(() => expect(asMock(apiService.get).mock.calls.some(([u]) => String(u).includes('/api/backup/settings'))).toBe(true));
    expect(asMock(apiService.get).mock.calls[0][0]).toBe('/api/backup/settings?sourceId=src-z');

    fireEvent.click(screen.getByText('backup_management.show_backups'));
    await waitFor(() => expect(screen.getByText('backup_2026.yaml')).toBeTruthy());
    expect(asMock(apiService.get).mock.calls.map(([u]) => u)).toContain('/api/backup/list?sourceId=src-z');

    fireEvent.click(screen.getByText('backup_management.download'));
    await waitFor(() => expect(apiService.getText).toHaveBeenCalledWith('/api/backup/download/backup_2026.yaml?sourceId=src-z'));

    fireEvent.click(screen.getByText('backup_management.restore'));
    await waitFor(() =>
      expect(asMock(apiService.get).mock.calls.map(([u]) => u)).toContain('/api/backup/summary/backup_2026.yaml?sourceId=src-z'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'backup_management.restore')!);
    await waitFor(() => expect(apiService.post).toHaveBeenCalled());
    expect(asMock(apiService.post).mock.calls[0][0]).toBe('/api/backup/restore/backup_2026.yaml');
    expect(asMock(apiService.post).mock.calls[0][1]).toEqual({ sourceId: 'src-z' });

    fireEvent.click(screen.getByText('backup_management.delete'));
    await waitFor(() => expect(apiService.delete).toHaveBeenCalledWith('/api/backup/delete/backup_2026.yaml?sourceId=src-z'));
  });

  it('the sourceId prop wins over the surrounding source context', async () => {
    sourceState.sourceId = 'ctx-source';
    render(<BackupManagementSection sourceId="prop-source" />);
    fireEvent.click(screen.getByText('backup_management.create_button'));
    await waitFor(() => expect(apiService.download).toHaveBeenCalled());
    expect(asMock(apiService.download).mock.calls[0][0]).toContain('sourceId=prop-source');
  });
});

describe('restore confirm dialog (#4926, #6285)', () => {
  async function clickRestore() {
    fireEvent.click(screen.getByText('backup_management.restore'));
    return screen.findByRole('dialog');
  }

  it('asks the server for a summary, shows a dialog, and posts only after confirm (no sourceId body when single-source)', async () => {
    await openBackupList();
    const dialog = await clickRestore();
    expect(apiService.post).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain('backup_management.restore_dialog_title');
    // confirm button inside the dialog
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'backup_management.restore')!);
    await waitFor(() => expect(apiService.post).toHaveBeenCalled());
    const [endpoint, body] = asMock(apiService.post).mock.calls[0];
    expect(endpoint).toBe('/api/backup/restore/backup_2026.yaml');
    expect(body).toEqual({});
  });

  it('does not call the restore API when the user cancels', async () => {
    await openBackupList();
    const dialog = await clickRestore();
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'common.cancel')!);
    expect(apiService.post).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows the radio-change warning when the backup radio differs from the current one', async () => {
    summary = summaryFor({
      protocol: 'meshcore',
      radio: { freq: 869.525, bw: 250, sf: 11, cr: 5 },
      currentRadio: { freq: 910.525, bw: 62.5, sf: 7, cr: 5 },
      radioDiffers: true,
      requiresReboot: false,
      channels: [{ idx: 1, name: 'Alpha' }, { idx: 4, name: '' }],
    });
    await openBackupList(<BackupManagementSection protocol="meshcore" sourceId="mc-1" />);
    const dialog = await clickRestore();
    const alert = dialog.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('backup_management.restore_radio_changes');
    // the mocked t() returns the key; the slots and the identity note are listed
    expect(dialog.textContent).toContain('backup_management.restore_channels_overwritten');
    expect(dialog.querySelectorAll('li')).toHaveLength(2);
    expect(dialog.textContent).toContain('backup_management.restore_no_identity');
  });

  it('shows no radio warning when the radios match', async () => {
    summary = summaryFor({ protocol: 'meshcore', radio: { freq: 910.525 }, currentRadio: { freq: 910.525 }, radioDiffers: false, requiresReboot: false });
    await openBackupList(<BackupManagementSection protocol="meshcore" sourceId="mc-1" />);
    const dialog = await clickRestore();
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
  });

  it('MeshCore hides the Meshtastic reboot text; Meshtastic shows it', async () => {
    summary = summaryFor({ protocol: 'meshcore', requiresReboot: true });
    const mc = await openBackupList(<BackupManagementSection protocol="meshcore" sourceId="mc-1" />);
    let dialog = await clickRestore();
    expect(dialog.textContent).not.toContain('backup_management.restore_meshtastic_reboot');
    expect(dialog.textContent).toContain('backup_management.restore_meshcore_pin_boot');
    mc.unmount();

    summary = summaryFor({ protocol: 'meshtastic', requiresReboot: true });
    await openBackupList(<BackupManagementSection protocol="meshtastic" />);
    dialog = await clickRestore();
    expect(dialog.textContent).toContain('backup_management.restore_meshtastic_reboot');
    expect(dialog.textContent).not.toContain('backup_management.restore_meshcore_pin_boot');
  });

  it('MeshCore success toast says the PIN applies at next boot, not that the device reboots', async () => {
    summary = summaryFor({ protocol: 'meshcore', requiresReboot: true });
    await openBackupList(<BackupManagementSection protocol="meshcore" sourceId="mc-1" />);
    const dialog = await clickRestore();
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'backup_management.restore')!);
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('backup_management.toast_restored_meshcore_boot', 'success'));
  });

  it('shows the plain restored toast (no reboot) when requiresReboot is false', async () => {
    asMock(apiService.post).mockResolvedValue({ data: { applied: ['config.device'], failed: [], channels: 0, requiresReboot: false } });
    await openBackupList();
    const dialog = await clickRestore();
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'backup_management.restore')!);
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('backup_management.toast_restored', 'success'));
  });

  it('an unowned backup needs the extra confirmation and posts confirmLegacy', async () => {
    authState.isAdmin = true;
    list = [{ filename: 'backup_2026.yaml', timestamp: '2026-08-25T00:00:00Z', size: 100, type: 'manual', legacy: true }];
    summary = summaryFor({ legacy: true });
    await openBackupList(<BackupManagementSection sourceId="src-b" />);
    const dialog = await clickRestore();
    const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'backup_management.restore')!;
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(dialog.querySelector('input[type="checkbox"]')!);
    expect(confirm.hasAttribute('disabled')).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(apiService.post).toHaveBeenCalled());
    expect(asMock(apiService.post).mock.calls[0][1]).toEqual({ sourceId: 'src-b', confirmLegacy: true });
  });

  it('toasts an error and shows no dialog when the summary cannot be read', async () => {
    asMock(apiService.get).mockImplementation((url: string) => {
      if (url.includes('/api/backup/list')) return Promise.resolve(list);
      if (url.includes('/api/backup/summary')) return Promise.reject(new Error('Backup not found'));
      return Promise.resolve(SETTINGS);
    });
    await openBackupList();
    fireEvent.click(screen.getByText('backup_management.restore'));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('backup_management.toast_restore_failed', 'error'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('offline radio and permissions', () => {
  it('create and restore are disabled while disconnected; list, download and delete still work', async () => {
    await openBackupList(<BackupManagementSection protocol="meshcore" sourceId="mc-1" connected={false} />);
    expect((screen.getByText('backup_management.create_button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('backup_management.restore') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('backup_management.download') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText('backup_management.delete') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a viewer without configuration:write cannot create, download, restore or delete', async () => {
    await openBackupList(<BackupManagementSection sourceId="src-1" canWrite={false} />);
    expect((screen.getByText('backup_management.create_button') as HTMLButtonElement).disabled).toBe(true);
    for (const key of ['download', 'restore', 'delete']) {
      expect((screen.getByText(`backup_management.${key}`) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe('legacy badge', () => {
  beforeEach(() => {
    list = [{ filename: 'backup_2026.yaml', timestamp: '2026-08-25T00:00:00Z', size: 100, type: 'manual', legacy: true }];
  });

  it('shows for admins only', async () => {
    authState.isAdmin = true;
    const admin = await openBackupList();
    expect(screen.queryByText('backup_management.legacy_badge')).not.toBeNull();
    admin.unmount();

    authState.isAdmin = false;
    await openBackupList();
    expect(screen.queryByText('backup_management.legacy_badge')).toBeNull();
  });
});

describe('schedule', () => {
  it('saves with the sourceId and shows the last automatic result', async () => {
    asMock(apiService.get).mockImplementation((url: string) =>
      Promise.resolve(url.includes('/settings')
        ? { ...SETTINGS, enabled: true, lastAutomaticBackupAt: '2026-11-09T02:00:00.000Z', lastAutomaticBackupError: 'SOURCE_NOT_CONNECTED' }
        : list));
    render(<BackupManagementSection sourceId="src-9" />);
    await waitFor(() => expect(screen.getByText(/backup_management.last_auto_failed/)).toBeTruthy());

    const { useSaveBar } = await import('../../hooks/useSaveBar');
    // The component registers its save handler with the save bar; find and run it.
    const onSave = asMock(useSaveBar).mock.calls.at(-1)![0].onSave as () => Promise<void>;
    await onSave();
    expect(asMock(apiService.post).mock.calls.at(-1)).toEqual([
      '/api/backup/settings',
      { enabled: true, maxBackups: 7, backupTime: '02:00', sourceId: 'src-9' },
    ]);
  });
});
