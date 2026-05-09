// @vitest-environment jsdom
/**
 * Regression coverage for the channel encryption label fix (#2939, PR #2944).
 *
 * The ChannelDatabaseSection card renders a "PSK: <preview> (<label>)" line
 * whose label depends on `pskLength`:
 *   0  -> renders "PSK: (none) (None)" (no preview, no AES label)
 *   1  -> "Shorthand (AES-128)"
 *   16 -> "AES-128"
 *   32 -> "AES-256"
 *   anything else -> "Unknown"
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ChannelDatabaseEntry } from '../../services/api';

const showToastMock = vi.fn();
vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: showToastMock, toasts: [] }),
}));

const getChannelDatabaseEntriesMock = vi.fn();
const getRetroactiveDecryptionProgressMock = vi.fn();
vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  return {
    ...actual,
    default: {
      getChannelDatabaseEntries: getChannelDatabaseEntriesMock,
      getRetroactiveDecryptionProgress: getRetroactiveDecryptionProgressMock,
      reorderChannelDatabaseEntries: vi.fn(),
      createChannelDatabaseEntry: vi.fn(),
      updateChannelDatabaseEntry: vi.fn(),
      deleteChannelDatabaseEntry: vi.fn(),
      triggerRetroactiveDecryption: vi.fn(),
    },
  };
});

vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const baseChannel: ChannelDatabaseEntry = {
  id: 1,
  name: 'TestChannel',
  pskLength: 16,
  pskPreview: 'AAAAAAAA...',
  description: null,
  isEnabled: true,
  enforceNameValidation: false,
  sortOrder: 0,
  decryptedPacketCount: 0,
  lastDecryptedAt: null,
  createdBy: null,
  createdAt: 0,
  updatedAt: 0,
};

const renderSection = async () => {
  const { default: ChannelDatabaseSection } = await import('./ChannelDatabaseSection');
  return render(<ChannelDatabaseSection isAdmin={true} />);
};

describe('ChannelDatabaseSection encryption label', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRetroactiveDecryptionProgressMock.mockResolvedValue({ isRunning: false, progress: null });
  });

  it('renders "None" for pskLength 0 with literal "(none)" preview', async () => {
    getChannelDatabaseEntriesMock.mockResolvedValue({
      data: [{ ...baseChannel, pskLength: 0, pskPreview: '(none)' }],
    });

    await renderSection();

    await waitFor(() => {
      expect(screen.getByText('PSK: (none) (None)')).toBeTruthy();
    });
    // Must not show any preview-style content for pskLength 0
    expect(screen.queryByText(/AAAAAAAA/)).toBeNull();
  });

  it('renders "Shorthand (AES-128)" for pskLength 1', async () => {
    getChannelDatabaseEntriesMock.mockResolvedValue({
      data: [{ ...baseChannel, pskLength: 1, pskPreview: 'AQ==...' }],
    });

    await renderSection();

    await waitFor(() => {
      expect(screen.getByText('PSK: AQ==... (Shorthand (AES-128))')).toBeTruthy();
    });
  });

  it('renders "AES-128" for pskLength 16', async () => {
    getChannelDatabaseEntriesMock.mockResolvedValue({
      data: [{ ...baseChannel, pskLength: 16, pskPreview: 'BBBBBBBB...' }],
    });

    await renderSection();

    await waitFor(() => {
      expect(screen.getByText('PSK: BBBBBBBB... (AES-128)')).toBeTruthy();
    });
  });

  it('renders "AES-256" for pskLength 32', async () => {
    getChannelDatabaseEntriesMock.mockResolvedValue({
      data: [{ ...baseChannel, pskLength: 32, pskPreview: 'CCCCCCCC...' }],
    });

    await renderSection();

    await waitFor(() => {
      expect(screen.getByText('PSK: CCCCCCCC... (AES-256)')).toBeTruthy();
    });
  });

  it('renders "Unknown" for an unexpected pskLength (e.g. 7)', async () => {
    getChannelDatabaseEntriesMock.mockResolvedValue({
      data: [{ ...baseChannel, pskLength: 7, pskPreview: 'DDDDDDDD...' }],
    });

    await renderSection();

    await waitFor(() => {
      expect(screen.getByText('PSK: DDDDDDDD... (Unknown)')).toBeTruthy();
    });
  });
});
