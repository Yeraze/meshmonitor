/**
 * @vitest-environment jsdom
 *
 * MeshCoreTelemetrySettingsSection (#6258 WP3).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MeshCoreTelemetrySettingsSection } from './MeshCoreTelemetrySettingsSection';

const SOURCE_ID = 'mc-source one';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const t = (key: string, fallback?: string | Record<string, unknown>) =>
    typeof fallback === 'string' ? fallback : key;
  return createReactI18nextMock(t);
});

const { hasPermissionMock } = vi.hoisted(() => ({ hasPermissionMock: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: hasPermissionMock }),
}));

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: showToastMock }) }));

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => csrfFetchMock }));

const { setHoursMock, setDaysMock } = vi.hoisted(() => ({ setHoursMock: vi.fn(), setDaysMock: vi.fn() }));
vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    telemetryVisualizationHours: 24,
    favoriteTelemetryStorageDays: 30,
    setTelemetryVisualizationHours: setHoursMock,
    setFavoriteTelemetryStorageDays: setDaysMock,
  }),
}));

const { saveBarCapture } = vi.hoisted(() => ({
  saveBarCapture: { current: null as null | { hasChanges: boolean; onSave: () => Promise<void> } },
}));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: unknown) => {
    saveBarCapture.current = options as typeof saveBarCapture.current;
  },
}));

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MeshCoreTelemetrySettingsSection baseUrl="" sourceId={SOURCE_ID} />
    </QueryClientProvider>,
  );
}

const hoursInput = () => document.getElementById('telemetryVisualizationHours') as HTMLInputElement;
const daysInput = () => document.getElementById('favoriteTelemetryStorageDays') as HTMLInputElement;

describe('MeshCoreTelemetrySettingsSection', () => {
  beforeEach(() => {
    hasPermissionMock.mockReset().mockReturnValue(true);
    showToastMock.mockReset();
    csrfFetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
    setHoursMock.mockReset();
    setDaysMock.mockReset();
    saveBarCapture.current = null;
  });

  it('seeds the inputs from the settings context', () => {
    renderSection();
    expect(hoursInput().value).toBe('24');
    expect(daysInput().value).toBe('30');
  });

  it('POSTs exactly two keys to the per-source settings URL and updates the context', async () => {
    renderSection();
    fireEvent.change(hoursInput(), { target: { value: '48' } });
    fireEvent.change(daysInput(), { target: { value: '60' } });
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));

    await saveBarCapture.current!.onSave();

    expect(csrfFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = csrfFetchMock.mock.calls[0];
    expect(url).toBe(`/api/settings?sourceId=${encodeURIComponent(SOURCE_ID)}`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      telemetryVisualizationHours: '48',
      favoriteTelemetryStorageDays: '60',
    });
    expect(setHoursMock).toHaveBeenCalledWith(48);
    expect(setDaysMock).toHaveBeenCalledWith(60);
    expect(showToastMock).toHaveBeenCalledWith('Settings saved', 'success');
  });

  it('disables both inputs without settings:write on this source', () => {
    hasPermissionMock.mockReturnValue(false);
    renderSection();
    expect(hoursInput().disabled).toBe(true);
    expect(daysInput().disabled).toBe(true);
    expect(hasPermissionMock).toHaveBeenCalledWith('settings', 'write', { sourceId: SOURCE_ID });
  });

  it('shows an error toast on 403 and leaves the context alone', async () => {
    csrfFetchMock.mockResolvedValue({ ok: false, status: 403 });
    renderSection();
    fireEvent.change(hoursInput(), { target: { value: '48' } });
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));

    await saveBarCapture.current!.onSave();

    expect(showToastMock).toHaveBeenCalledWith('Insufficient permissions', 'error');
    expect(setHoursMock).not.toHaveBeenCalled();
    expect(setDaysMock).not.toHaveBeenCalled();
  });
});
