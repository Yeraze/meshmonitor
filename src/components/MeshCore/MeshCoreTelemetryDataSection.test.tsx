/**
 * @vitest-environment jsdom
 *
 * MeshCoreTelemetryDataSection (#6258 WP3).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@testing-library/react';
import { MeshCoreTelemetryDataSection } from './MeshCoreTelemetryDataSection';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const t = (key: string, fallback?: string | Record<string, unknown>) =>
    typeof fallback === 'string' ? fallback : key;
  return createReactI18nextMock(t);
});

const { authState } = vi.hoisted(() => ({ authState: { isAdmin: true } }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ authStatus: { authenticated: true, user: { isAdmin: authState.isAdmin } } }),
}));

vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'src-1', sourceName: 'Mesh One' }),
}));

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: showToastMock }) }));

vi.mock('../../services/api', () => ({
  default: { purgeTelemetry: vi.fn() },
}));
import apiService from '../../services/api';

const { dialogProps } = vi.hoisted(() => ({ dialogProps: { current: null as any } }));
vi.mock('../TelemetryOutlierDialog/TelemetryOutlierDialog', () => ({
  default: (props: any) => {
    dialogProps.current = props;
    return props.isOpen ? <div data-testid="outlier-dialog" /> : null;
  },
}));
vi.mock('../TelemetryChart', () => ({ getTelemetryLabel: (s: string) => s }));

describe('MeshCoreTelemetryDataSection', () => {
  beforeEach(() => {
    authState.isAdmin = true;
    showToastMock.mockReset();
    vi.mocked(apiService.purgeTelemetry).mockReset().mockResolvedValue(undefined as never);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders nothing for a non-admin', () => {
    authState.isAdmin = false;
    const { container } = render(<MeshCoreTelemetryDataSection sourceId="src-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('purges with the source id after confirmation', async () => {
    render(<MeshCoreTelemetryDataSection sourceId="src-1" />);
    fireEvent.click(screen.getByText(/Purge telemetry \(this source\)/));
    await waitFor(() => expect(apiService.purgeTelemetry).toHaveBeenCalledWith(0, 'src-1'));
    expect(showToastMock).toHaveBeenCalledWith('Telemetry for this source purged', 'success');
  });

  it('does not purge when the confirm is declined', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<MeshCoreTelemetryDataSection sourceId="src-1" />);
    fireEvent.click(screen.getByText(/Purge telemetry \(this source\)/));
    expect(apiService.purgeTelemetry).not.toHaveBeenCalled();
  });

  it('opens the outlier dialog with exactly this source', () => {
    render(<MeshCoreTelemetryDataSection sourceId="src-1" />);
    expect(screen.queryByTestId('outlier-dialog')).toBeNull();
    fireEvent.click(screen.getByText(/Clean outliers/));
    expect(screen.getByTestId('outlier-dialog')).toBeTruthy();
    expect(dialogProps.current.sourceId).toBe('src-1');
    expect(dialogProps.current.sources).toEqual([{ id: 'src-1', name: 'Mesh One' }]);
  });
});
