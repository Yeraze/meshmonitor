/**
 * @vitest-environment jsdom
 *
 * ReticulumConfigurationView (#3960 Phase 3) — RNode radio config + device
 * info for an own-mode source. Covers: loads config into the form via the
 * ok() envelope (.data), renders device-info, and the read-only gate when the
 * user lacks `configuration:write` (inputs disabled + banner shown).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ReticulumConfigurationView } from './ReticulumConfigurationView';
import api from '../../services/api';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const hasPermissionMock = vi.fn(() => true);
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: hasPermissionMock }),
}));

vi.mock('../../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));

const mockedApi = api as unknown as {
  get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>;
};

const RADIO = {
  frequency: 915000000, bandwidth: 250000, spreadingFactor: 8, codingRate: 5,
  txPower: 17, stAlock: null, ltAlock: null, radioState: true,
};
const DEVICE = { firmwareVersion: '1.79', mcu: 'ESP32', platform: 'Heltec' };

beforeEach(() => {
  hasPermissionMock.mockReturnValue(true);
  mockedApi.get.mockImplementation((url: string) => {
    if (url.endsWith('/radio-config')) return Promise.resolve({ data: RADIO });
    if (url.endsWith('/device-info')) return Promise.resolve({ data: DEVICE });
    return Promise.resolve({ data: null });
  });
  mockedApi.post.mockReset();
  mockedApi.put.mockReset().mockResolvedValue({ success: true });
});

describe('ReticulumConfigurationView', () => {
  it('loads the radio config into the form and renders device info', async () => {
    render(<ReticulumConfigurationView sourceId="src-rns" />);
    await waitFor(() => expect(screen.getByDisplayValue('915000000')).toBeTruthy());
    expect(screen.getByDisplayValue('250000')).toBeTruthy();
    expect(screen.getByDisplayValue('8')).toBeTruthy();
    expect(screen.getByText('1.79')).toBeTruthy();
    expect(screen.getByText('ESP32')).toBeTruthy();
  });

  it('enables the Apply button and editable inputs when the user can write', async () => {
    render(<ReticulumConfigurationView sourceId="src-rns" />);
    const apply = await screen.findByRole('button', { name: /apply/i });
    expect((apply as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the read-only banner and disables inputs without write permission', async () => {
    hasPermissionMock.mockReturnValue(false);
    render(<ReticulumConfigurationView sourceId="src-rns" />);
    await waitFor(() => expect(screen.getByDisplayValue('915000000')).toBeTruthy());
    expect(screen.getByRole('status')).toBeTruthy();
    const apply = screen.getByRole('button', { name: /apply/i }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect((screen.getByDisplayValue('915000000') as HTMLInputElement).disabled).toBe(true);
  });

  it('requests both radio-config and device-info scoped to the source', async () => {
    render(<ReticulumConfigurationView sourceId="src-rns" />);
    await waitFor(() => expect(mockedApi.get).toHaveBeenCalledWith(
      expect.stringContaining('/api/sources/src-rns/reticulum/radio-config'),
    ));
    expect(mockedApi.get).toHaveBeenCalledWith(
      expect.stringContaining('/api/sources/src-rns/reticulum/device-info'),
    );
  });

  it('applies with PUT (the only verb the server accepts), leaving out blank fields', async () => {
    render(<ReticulumConfigurationView sourceId="src-rns" />);
    fireEvent.click(await screen.findByRole('button', { name: /apply/i }));
    await waitFor(() => expect(mockedApi.put).toHaveBeenCalledTimes(1));
    expect(mockedApi.post).not.toHaveBeenCalled();
    const [url, body] = mockedApi.put.mock.calls[0];
    expect(url).toBe('/api/sources/src-rns/reticulum/radio-config');
    expect(body).toEqual({
      frequency: 915000000, bandwidth: 250000, spreadingFactor: 8, codingRate: 5, txPower: 17, radioState: true,
    });
  });

  it('shows the radio as on from the boolean radioState and sends a boolean back', async () => {
    render(<ReticulumConfigurationView sourceId="src-rns" />);
    const radioOn = (await screen.findByRole('checkbox')) as HTMLInputElement;
    await waitFor(() => expect(radioOn.checked).toBe(true));
    fireEvent.click(radioOn);
    expect(radioOn.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    await waitFor(() => expect(mockedApi.put).toHaveBeenCalledTimes(1));
    expect(mockedApi.put.mock.calls[0][1].radioState).toBe(false);
  });
});
