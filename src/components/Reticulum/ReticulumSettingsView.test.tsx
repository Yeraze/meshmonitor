/**
 * @vitest-environment jsdom
 *
 * ReticulumSettingsView (#3960 Phase 1b WP5) — thin one-setting view for
 * `reticulum_destinations_max`. This key is deliberately GLOBAL (see the
 * module doc on the component) — `ReticulumRepository.getDestinationsMax()`
 * reads it with no `sourceId`, so this view reads/writes the generic
 * `/api/settings` endpoint (no `?sourceId=`), mirroring
 * `DatabaseMaintenanceSection.tsx`'s apiService.get/post + useSaveBar
 * pattern. `useSaveBar` is mocked to capture its options so the save/dismiss
 * path can be driven directly, the same strategy
 * `MeshCoreNodeDisplaySection.test.tsx` uses.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ReticulumSettingsView } from './ReticulumSettingsView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

const { hasPermissionMock } = vi.hoisted(() => ({ hasPermissionMock: vi.fn(() => true) }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: hasPermissionMock }),
}));

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

const { saveBarCapture } = vi.hoisted(() => ({
  saveBarCapture: {
    current: null as null | {
      hasChanges: boolean;
      isSaving: boolean;
      onSave: () => Promise<void>;
      onDismiss: () => void;
    },
  },
}));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: unknown) => {
    saveBarCapture.current = options as typeof saveBarCapture.current;
  },
}));

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  default: { get: apiGetMock, post: apiPostMock },
  ApiError: class ApiError extends Error {},
}));

const SOURCE_ID = 'rns-source-1';

describe('ReticulumSettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasPermissionMock.mockReturnValue(true);
    saveBarCapture.current = null;
    apiGetMock.mockResolvedValue({ reticulum_destinations_max: '3000' });
    apiPostMock.mockResolvedValue({ success: true });
  });

  it('renders and loads the current retention cap from GET /api/settings (no sourceId)', async () => {
    render(<ReticulumSettingsView sourceId={SOURCE_ID} />);

    expect(screen.getByTestId('reticulum-settings-view')).toBeInTheDocument();
    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith('/api/settings');
    });

    const input = await screen.findByLabelText(/destination retention cap/i) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('3000'));
  });

  it('falls back to the default cap when the setting is unset', async () => {
    apiGetMock.mockResolvedValueOnce({});
    render(<ReticulumSettingsView sourceId={SOURCE_ID} />);

    const input = await screen.findByLabelText(/destination retention cap/i) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('2000'));
  });

  it('registers a SaveBar section and saves the new value via POST /api/settings (no sourceId)', async () => {
    render(<ReticulumSettingsView sourceId={SOURCE_ID} />);

    const input = await screen.findByLabelText(/destination retention cap/i) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('3000'));

    fireEvent.change(input, { target: { value: '5000' } });

    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));

    await saveBarCapture.current!.onSave();

    expect(apiPostMock).toHaveBeenCalledWith('/api/settings', { reticulum_destinations_max: '5000' });
    expect(showToastMock).toHaveBeenCalledWith(expect.stringMatching(/saved/i), 'success');
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(false));
  });

  it('disables the input when the user lacks settings:write permission', async () => {
    hasPermissionMock.mockReturnValue(false);
    render(<ReticulumSettingsView sourceId={SOURCE_ID} />);

    const input = await screen.findByLabelText(/destination retention cap/i) as HTMLInputElement;
    await waitFor(() => expect(input).toBeDisabled());
  });
});
