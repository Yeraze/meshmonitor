/**
 * @vitest-environment jsdom
 *
 * ReliablePkiSection (#5691): the global default in Global Settings → Security
 * and the per-source override on a source's Settings page. Default Off; the
 * airtime warning sits beside the control; the source scope writes the
 * source-scoped key with `?sourceId=`.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { ReliablePkiSection, RELIABLE_PKI_SECTION_ID } from './ReliablePkiSection';

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
    current: null as null | { hasChanges: boolean; onSave: () => Promise<void>; onDismiss: () => void },
  },
}));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: unknown) => { saveBarCapture.current = options as typeof saveBarCapture.current; },
}));

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({ apiGetMock: vi.fn(), apiPostMock: vi.fn() }));
vi.mock('../../services/api', () => ({
  default: { get: apiGetMock, post: apiPostMock },
  ApiError: class ApiError extends Error {},
}));

const WARNING = /at most once an hour per node.*uses airtime/i;

describe('ReliablePkiSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasPermissionMock.mockReturnValue(true);
    saveBarCapture.current = null;
    apiPostMock.mockResolvedValue({ success: true });
  });

  it('global: defaults to Off, shows the airtime warning, offers only Off / As needed', async () => {
    apiGetMock.mockResolvedValue({});
    render(<ReliablePkiSection scope="global" />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith('/api/settings'));
    const select = await screen.findByLabelText(/default for every source/i) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe('off');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['off', 'asNeeded']);
    expect(screen.getByTestId('reliable-pki-cost-warning').textContent).toMatch(WARNING);
  });

  it('global: saves reliablePkiMode with no sourceId', async () => {
    apiGetMock.mockResolvedValue({ reliablePkiMode: 'off' });
    render(<ReliablePkiSection scope="global" />);
    const select = await screen.findByLabelText(/default for every source/i) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: 'asNeeded' } });
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));
    await act(async () => { await saveBarCapture.current!.onSave(); });
    expect(apiPostMock).toHaveBeenCalledWith('/api/settings', { reliablePkiMode: 'asNeeded' });
  });

  it('source: reads the merged view, offers inherit, saves the source-scoped key with ?sourceId=', async () => {
    apiGetMock.mockResolvedValue({ reliablePkiMode: 'asNeeded' });
    render(<ReliablePkiSection scope="source" sourceId="src a" />);
    expect(screen.getByTestId('reliable-pki-section').id).toBe(RELIABLE_PKI_SECTION_ID);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith('/api/settings?sourceId=src%20a'));
    const select = await screen.findByLabelText(/for this source/i) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe('inherit');
    expect(select.options[0].textContent).toMatch(/As needed/);
    expect(screen.getByTestId('reliable-pki-cost-warning')).toBeTruthy();
    fireEvent.change(select, { target: { value: 'off' } });
    await act(async () => { await saveBarCapture.current!.onSave(); });
    expect(apiPostMock).toHaveBeenCalledWith('/api/settings?sourceId=src%20a', { reliablePkiSourceMode: 'off' });
  });

  it('is read-only without settings:write', async () => {
    hasPermissionMock.mockReturnValue(false);
    apiGetMock.mockResolvedValue({});
    render(<ReliablePkiSection scope="source" sourceId="s" />);
    const select = await screen.findByLabelText(/for this source/i) as HTMLSelectElement;
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect(select.disabled).toBe(true);
  });
});
