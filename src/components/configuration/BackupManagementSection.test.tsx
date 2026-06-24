/**
 * @vitest-environment jsdom
 *
 * Issue #3711: Manual Backup must scope to the currently-selected source so
 * multi-source setups back up the active source instead of always defaulting
 * to the primary one. Single-source (sourceId === null) views must keep the
 * old un-parameterized URL so the backend's primary-manager fallback applies.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// --- mocks ---------------------------------------------------------------

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../services/api', () => ({
  default: {
    getBaseUrl: vi.fn().mockResolvedValue('http://test'),
  },
}));

// sourceId is configurable per-test via this mutable holder.
const sourceState: { sourceId: string | null; sourceName: string | null } = {
  sourceId: null,
  sourceName: null,
};
vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => sourceState,
}));

import BackupManagementSection from './BackupManagementSection';

function makeFetchMock() {
  return vi.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/backup/settings')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ enabled: false, maxBackups: 7, backupTime: '02:00' }),
      });
    }
    // device/backup
    return Promise.resolve({
      ok: true,
      headers: { get: () => 'attachment; filename="abc.yaml"' },
      text: () => Promise.resolve('yaml: content'),
    });
  });
}

describe('BackupManagementSection — issue #3711 source scoping', () => {
  beforeEach(() => {
    sourceState.sourceId = null;
    sourceState.sourceName = null;
    // Avoid real download side-effects.
    global.URL.createObjectURL = vi.fn(() => 'blob:x');
    global.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes sourceId in the manual backup request when a source is selected', async () => {
    sourceState.sourceId = 'src-b';
    sourceState.sourceName = 'B';
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<BackupManagementSection />);
    fireEvent.click(screen.getByText('backup_management.create_button'));

    await waitFor(() => {
      const calledBackup = fetchMock.mock.calls.some(
        ([u]) => typeof u === 'string' && u.includes('/api/device/backup') && u.includes('sourceId=src-b')
      );
      expect(calledBackup).toBe(true);
    });
  });

  it('omits sourceId when no source is selected (single-source fallback)', async () => {
    sourceState.sourceId = null;
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<BackupManagementSection />);
    fireEvent.click(screen.getByText('backup_management.create_button'));

    await waitFor(() => {
      const backupCall = fetchMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.includes('/api/device/backup')
      );
      expect(backupCall).toBeTruthy();
      expect(backupCall![0]).not.toContain('sourceId=');
    });
  });
});
