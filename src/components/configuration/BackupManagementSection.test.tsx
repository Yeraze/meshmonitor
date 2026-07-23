/**
 * @vitest-environment jsdom
 *
 * Issue #3711: Manual Backup must scope to the currently-selected source so
 * multi-source setups back up the active source instead of always defaulting
 * to the primary one. Single-source (sourceId === null) views must keep the
 * old un-parameterized URL so the backend's primary-manager fallback applies.
 *
 * #3962 Task 5.5: the component's manual-backup call was migrated from raw
 * fetch() to apiService.download(). These tests now assert directly on the
 * apiService.download mock's call arguments (the endpoint string) instead of
 * spying on global.fetch, since ApiService itself — not fetch — is the
 * component's request boundary post-migration. The sourceId
 * inclusion/omission semantics being pinned are unchanged.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
      get: vi.fn().mockResolvedValue({ enabled: false, maxBackups: 7, backupTime: '02:00' }),
      download: vi.fn().mockResolvedValue(undefined),
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

import apiService from '../../services/api';
import BackupManagementSection from './BackupManagementSection';

describe('BackupManagementSection — issue #3711 source scoping', () => {
  beforeEach(() => {
    sourceState.sourceId = null;
    sourceState.sourceName = null;
    vi.clearAllMocks();
    // clearAllMocks() wipes call history; re-arm the resolved values it
    // also clears the underlying implementation reference for.
    (apiService.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: false,
      maxBackups: 7,
      backupTime: '02:00',
    });
    (apiService.download as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('includes sourceId in the manual backup request when a source is selected', async () => {
    sourceState.sourceId = 'src-b';
    sourceState.sourceName = 'B';

    render(<BackupManagementSection />);
    fireEvent.click(screen.getByText('backup_management.create_button'));

    await waitFor(() => {
      expect(apiService.download).toHaveBeenCalled();
    });

    const [endpoint] = (apiService.download as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(endpoint).toContain('/api/device/backup');
    expect(endpoint).toContain('sourceId=src-b');
  });

  it('omits sourceId when no source is selected (single-source fallback)', async () => {
    sourceState.sourceId = null;

    render(<BackupManagementSection />);
    fireEvent.click(screen.getByText('backup_management.create_button'));

    await waitFor(() => {
      expect(apiService.download).toHaveBeenCalled();
    });

    const [endpoint] = (apiService.download as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(endpoint).toContain('/api/device/backup');
    expect(endpoint).not.toContain('sourceId=');
  });
});
