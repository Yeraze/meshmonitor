/**
 * @vitest-environment jsdom
 *
 * ReticulumRetentionSection — the Global Settings section for
 * `reticulum_destinations_max` (#3960 Phase 1b WP5; moved off the per-source
 * Settings page by the #5683 follow-up). This key is GLOBAL (see the
 * module doc on the component) — `ReticulumRepository.getDestinationsMax()`
 * reads it with no `sourceId`, so the section reads/writes the generic
 * `/api/settings` endpoint (no `?sourceId=`), mirroring
 * `DatabaseMaintenanceSection.tsx`'s apiService.get/post + useSaveBar
 * pattern. `useSaveBar` is mocked to capture its options so the save/dismiss
 * path can be driven directly, the same strategy
 * `MeshCoreNodeDisplaySection.test.tsx` uses.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ReticulumRetentionSection, RETICULUM_SETTINGS_SECTION_ID } from './ReticulumRetentionSection';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

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

describe('ReticulumRetentionSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasPermissionMock.mockReturnValue(true);
    saveBarCapture.current = null;
    apiGetMock.mockResolvedValue({ reticulum_destinations_max: '3000' });
    apiPostMock.mockResolvedValue({ success: true });
  });

  it('renders and loads the current retention cap from GET /api/settings (no sourceId)', async () => {
    render(<ReticulumRetentionSection />);

    // The anchor the Global Settings nav chip and the old page's pointer use.
    expect(screen.getByTestId('reticulum-retention-section').id).toBe(RETICULUM_SETTINGS_SECTION_ID);
    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith('/api/settings');
    });

    const input = await screen.findByLabelText(/destination retention cap/i) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('3000'));
  });

  it('falls back to the default cap when the setting is unset', async () => {
    apiGetMock.mockResolvedValueOnce({});
    render(<ReticulumRetentionSection />);

    const input = await screen.findByLabelText(/destination retention cap/i) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('2000'));
  });

  it('registers a SaveBar section and saves the new value via POST /api/settings (no sourceId)', async () => {
    render(<ReticulumRetentionSection />);

    const input = await screen.findByLabelText(/destination retention cap/i) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('3000'));

    fireEvent.change(input, { target: { value: '5000' } });

    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));

    await saveBarCapture.current!.onSave();

    expect(apiPostMock).toHaveBeenCalledWith('/api/settings', { reticulum_destinations_max: '5000' });
    expect(showToastMock).toHaveBeenCalledWith(expect.stringMatching(/saved/i), 'success');
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(false));
  });

  it('saves nothing on mount: a POST needs an edit and a Save', async () => {
    render(<ReticulumRetentionSection />);
    const input = await screen.findByLabelText(/destination retention cap/i) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('3000'));
    expect(saveBarCapture.current?.hasChanges).toBe(false);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('Dismiss puts an unsaved edit back and sends nothing', async () => {
    render(<ReticulumRetentionSection />);
    const input = await screen.findByLabelText(/destination retention cap/i) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('3000'));
    fireEvent.change(input, { target: { value: '5000' } });
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));
    saveBarCapture.current!.onDismiss();
    await waitFor(() => expect(input.value).toBe('3000'));
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('asks for the write grant on any source: the key is global', async () => {
    render(<ReticulumRetentionSection />);
    await screen.findByLabelText(/destination retention cap/i);
    expect(hasPermissionMock).toHaveBeenCalledWith('settings', 'write', { anySource: true });
  });

  it('disables the input when the user lacks settings:write permission', async () => {
    hasPermissionMock.mockReturnValue(false);
    render(<ReticulumRetentionSection />);

    const input = await screen.findByLabelText(/destination retention cap/i) as HTMLInputElement;
    await waitFor(() => expect(input).toBeDisabled());
  });
});
