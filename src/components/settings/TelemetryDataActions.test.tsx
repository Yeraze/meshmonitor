/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@testing-library/react';
import { TelemetryDataActions } from './TelemetryDataActions';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock((key: string) => key);
});

const { authState } = vi.hoisted(() => ({ authState: { isAdmin: true } }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ authStatus: { authenticated: true, user: { isAdmin: authState.isAdmin } } }),
}));

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: showToastMock }) }));

vi.mock('../../services/api', () => ({ default: { purgeTelemetry: vi.fn() } }));
import apiService from '../../services/api';

const { dialogProps } = vi.hoisted(() => ({ dialogProps: { current: null as any } }));
vi.mock('../TelemetryOutlierDialog/TelemetryOutlierDialog', () => ({
  default: (props: any) => {
    dialogProps.current = props;
    return props.isOpen ? <div data-testid="outlier-dialog" /> : null;
  },
}));
vi.mock('../TelemetryChart', () => ({ getTelemetryLabel: (s: string) => s }));

const sources = [{ id: 'src-1', name: 'Mesh One' }];

describe('TelemetryDataActions', () => {
  beforeEach(() => {
    authState.isAdmin = true;
    showToastMock.mockReset();
    vi.mocked(apiService.purgeTelemetry).mockReset().mockResolvedValue(undefined as never);
  });

  it('purges one source with the source-scoped confirm copy', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<TelemetryDataActions sourceId="src-1" sources={sources} />);
    expect(screen.getByText('settings.purge_telemetry_description_source')).toBeTruthy();
    fireEvent.click(screen.getByText('settings.purge_telemetry_button'));
    await waitFor(() => expect(apiService.purgeTelemetry).toHaveBeenCalledWith(0, 'src-1'));
    const text = String(confirmSpy.mock.calls.at(-1)?.[0]);
    expect(text).toContain('settings.confirm_purge_telemetry_title_source');
    expect(text).toContain('settings.confirm_purge_telemetry_item1_source');
    expect(showToastMock).toHaveBeenCalledWith('toast.telemetry_purged', 'success');
  });

  it('purges all sources with the global copy when no source is set', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<TelemetryDataActions sourceId={null} sources={sources} />);
    expect(screen.getByText('settings.purge_telemetry_description')).toBeTruthy();
    fireEvent.click(screen.getByText('settings.purge_telemetry_button'));
    await waitFor(() => expect(apiService.purgeTelemetry).toHaveBeenCalledWith(0, undefined));
    const text = String(confirmSpy.mock.calls.at(-1)?.[0]);
    expect(text).toContain('settings.confirm_purge_telemetry_title\n');
    expect(text).not.toContain('_source');
  });

  it('does not purge when the confirm is declined', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<TelemetryDataActions sourceId="src-1" sources={sources} />);
    fireEvent.click(screen.getByText('settings.purge_telemetry_button'));
    expect(apiService.purgeTelemetry).not.toHaveBeenCalled();
  });

  it('shows an error toast when the purge fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(apiService.purgeTelemetry).mockRejectedValue(new Error('boom'));
    render(<TelemetryDataActions sourceId="src-1" sources={sources} />);
    fireEvent.click(screen.getByText('settings.purge_telemetry_button'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith('toast.telemetry_purge_failed', 'error'));
  });

  it('opens the outlier dialog for an admin with the given scope', () => {
    render(<TelemetryDataActions sourceId="src-1" sources={sources} />);
    expect(screen.queryByTestId('outlier-dialog')).toBeNull();
    fireEvent.click(screen.getByText('settings.clean_outliers_button'));
    expect(screen.getByTestId('outlier-dialog')).toBeTruthy();
    expect(dialogProps.current.sourceId).toBe('src-1');
    expect(dialogProps.current.sources).toEqual(sources);
  });

  it('hides the outlier action from a non-admin', () => {
    authState.isAdmin = false;
    render(<TelemetryDataActions sourceId="src-1" sources={sources} />);
    expect(screen.queryByText('settings.clean_outliers_button')).toBeNull();
    expect(screen.getByText('settings.purge_telemetry_button')).toBeTruthy();
  });
});
