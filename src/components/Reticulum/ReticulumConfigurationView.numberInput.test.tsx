/**
 * @vitest-environment jsdom
 *
 * Reticulum number fields (#5649).
 *
 * ReticulumConfigurationView: every radio field is optional (blank = null =
 * left out of the patch), but a value that is present must be in range before
 * Apply can send it to the RNode.
 *
 * ReticulumRetentionSection (the destination cap, on Global Settings since the
 * #5683 follow-up): the cap is required, so blank blocks the SaveBar.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReticulumConfigurationView } from './ReticulumConfigurationView';
import { ReticulumRetentionSection } from '../settings/ReticulumRetentionSection';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({ apiGetMock: vi.fn(), apiPostMock: vi.fn() }));
vi.mock('../../services/api', () => ({
  default: { get: apiGetMock, post: apiPostMock },
  ApiError: class ApiError extends Error {},
}));

interface CapturedSaveBar {
  hasChanges: boolean;
  onSave: () => Promise<void>;
  onDismiss: () => void;
  numberScope?: { invalid: boolean; reset: () => void };
}
const { saveBarCapture } = vi.hoisted(() => ({ saveBarCapture: { current: null as null | CapturedSaveBar } }));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: CapturedSaveBar) => {
    saveBarCapture.current = options;
  },
}));

const RADIO = {
  frequency: 915000000, bandwidth: 250000, spreadingFactor: 8, codingRate: 5,
  txPower: 17, stAlock: null, ltAlock: null, radioState: 1,
};

describe('ReticulumConfigurationView number fields (#5649)', () => {
  beforeEach(() => {
    apiGetMock.mockReset().mockImplementation((url: string) => {
      if (url.endsWith('/radio-config')) return Promise.resolve({ data: RADIO });
      return Promise.resolve({ data: null });
    });
    apiPostMock.mockReset().mockResolvedValue({ success: true });
  });

  const apply = () => screen.getByRole('button', { name: /apply/i }) as HTMLButtonElement;

  it('disables Apply while a field is out of range and re-enables it when fixed', async () => {
    const user = userEvent.setup();
    render(<ReticulumConfigurationView sourceId="src-rns" />);
    const sf = (await screen.findByDisplayValue('8')) as HTMLInputElement;
    expect(apply().disabled).toBe(false);

    await user.clear(sf);
    await user.type(sf, '99');
    expect(sf).toHaveAttribute('aria-invalid', 'true');
    expect(apply().disabled).toBe(true);
    await user.click(apply());
    expect(apiPostMock).not.toHaveBeenCalled();

    await user.clear(sf);
    await user.type(sf, '9');
    expect(sf).not.toHaveAttribute('aria-invalid');
    expect(apply().disabled).toBe(false);

    await user.click(apply());
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
    const [url, body] = apiPostMock.mock.calls[0];
    expect(url).toContain('/api/sources/src-rns/reticulum/radio-config');
    // Numbers stay numbers; nothing is sent as '' or NaN.
    expect(body.spreadingFactor).toBe(9);
    expect(body.frequency).toBe(915000000);
    for (const v of Object.values(body)) {
      expect(v === null || typeof v === 'number').toBe(true);
      if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('keeps blank legal: a cleared field is sent as null and does not block Apply', async () => {
    const user = userEvent.setup();
    render(<ReticulumConfigurationView sourceId="src-rns" />);
    const txPower = (await screen.findByDisplayValue('17')) as HTMLInputElement;

    await user.clear(txPower);
    expect(txPower.value).toBe('');
    expect(txPower).not.toHaveAttribute('aria-invalid');
    expect(apply().disabled).toBe(false);

    await user.click(apply());
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
    expect(apiPostMock.mock.calls[0][1].txPower).toBeNull();
  });

  it('blocks TX power above 22 dBm', async () => {
    const user = userEvent.setup();
    render(<ReticulumConfigurationView sourceId="src-rns" />);
    const txPower = (await screen.findByDisplayValue('17')) as HTMLInputElement;

    await user.clear(txPower);
    await user.type(txPower, '30');
    expect(txPower).toHaveAttribute('aria-invalid', 'true');
    expect(apply().disabled).toBe(true);
  });
});

describe('ReticulumRetentionSection destination cap (#5649)', () => {
  beforeEach(() => {
    saveBarCapture.current = null;
    apiGetMock.mockReset().mockResolvedValue({ reticulum_destinations_max: '2000' });
    apiPostMock.mockReset().mockResolvedValue({ success: true });
  });

  it('blocks the SaveBar while the cap is blank and saves the retyped value', async () => {
    const user = userEvent.setup();
    render(<ReticulumRetentionSection />);
    const cap = document.getElementById('reticulumDestinationsMax') as HTMLInputElement;
    await waitFor(() => expect(cap.disabled).toBe(false));
    expect(cap.value).toBe('2000');

    await user.clear(cap);
    // It used to snap to the minimum (1) here.
    expect(cap.value).toBe('');
    expect(cap).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(saveBarCapture.current?.numberScope?.invalid).toBe(true));
    expect(saveBarCapture.current?.hasChanges).toBe(false);

    await user.type(cap, '500');
    await waitFor(() => expect(saveBarCapture.current?.numberScope?.invalid).toBe(false));
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));

    await act(async () => { await saveBarCapture.current!.onSave(); });
    expect(apiPostMock).toHaveBeenCalledWith('/api/settings', { reticulum_destinations_max: '500' });
  });

  it('blocks a cap of 0 instead of clamping it to 1', async () => {
    const user = userEvent.setup();
    render(<ReticulumRetentionSection />);
    const cap = document.getElementById('reticulumDestinationsMax') as HTMLInputElement;
    await waitFor(() => expect(cap.disabled).toBe(false));

    await user.clear(cap);
    await user.type(cap, '0');
    expect(cap.value).toBe('0');
    expect(cap).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(saveBarCapture.current?.numberScope?.invalid).toBe(true));
  });
});
