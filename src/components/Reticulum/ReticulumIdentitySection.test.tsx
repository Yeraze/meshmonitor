/**
 * @vitest-environment jsdom
 *
 * ReticulumIdentitySection (#6011): LXMF display name, Announce now and the
 * periodic announce interval on the Reticulum Configuration page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReticulumIdentitySection } from './ReticulumIdentitySection';
import { ReticulumConfigurationView } from './ReticulumConfigurationView';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

const { apiGet, apiPut, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../services/api', () => ({
  default: { get: apiGet, put: apiPut, post: apiPost },
}));

const HASH = 'ab'.repeat(16);

function settings(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      connected: true,
      destinationHash: HASH,
      displayName: 'Base Camp',
      maxDisplayNameLength: 64,
      announceIntervalHours: 0,
      cooldownSeconds: 60,
      lastAnnounceAt: null,
      cooldownRemainingSeconds: 0,
      nextPeriodicAnnounceAt: null,
      ...overrides,
    },
  };
}

const announceBtn = () => screen.getByRole('button', { name: /announce now/i }) as HTMLButtonElement;
const saveBtn = () => screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement;

beforeEach(() => {
  apiGet.mockReset().mockResolvedValue(settings());
  apiPut.mockReset().mockResolvedValue({ success: true, data: { applied: true } });
  apiPost.mockReset().mockResolvedValue({ success: true, data: { announcedAt: 1 } });
});

describe('ReticulumIdentitySection', () => {
  it('shows the destination hash and the saved name', async () => {
    render(<ReticulumIdentitySection sourceId="src-rns" canWrite />);
    expect(await screen.findByText(HASH)).toBeTruthy();
    expect(screen.getByDisplayValue('Base Camp')).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith('/api/sources/src-rns/reticulum/announce-settings');
  });

  it('saves the trimmed name without announcing', async () => {
    const user = userEvent.setup();
    render(<ReticulumIdentitySection sourceId="src-rns" canWrite />);
    const input = await screen.findByDisplayValue('Base Camp');
    expect(saveBtn().disabled).toBe(true); // nothing changed yet
    await user.clear(input);
    await user.type(input, '  Hilltop  ');
    await user.click(saveBtn());
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/api/sources/src-rns/reticulum/display-name', { name: 'Hilltop' }));
    expect(apiPost).not.toHaveBeenCalled();
    expect(apiPut).not.toHaveBeenCalledWith(expect.stringContaining('announce-interval'), expect.anything());
  });

  it('caps the name input at the server limit', async () => {
    render(<ReticulumIdentitySection sourceId="src-rns" canWrite />);
    const input = (await screen.findByDisplayValue('Base Camp')) as HTMLInputElement;
    expect(input.maxLength).toBe(64);
  });

  it('saves the periodic interval and shows the airtime warning', async () => {
    const user = userEvent.setup();
    render(<ReticulumIdentitySection sourceId="src-rns" canWrite />);
    await screen.findByDisplayValue('Base Camp');
    expect(screen.queryByText(/transport nodes repeat it/i)).toBeNull();
    await user.selectOptions(screen.getByRole('combobox'), '6');
    expect(screen.getByText(/transport nodes repeat it/i)).toBeTruthy();
    await user.click(saveBtn());
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/api/sources/src-rns/reticulum/announce-interval', { hours: 6 }));
    expect(apiPut).not.toHaveBeenCalledWith(expect.stringContaining('display-name'), expect.anything());
  });

  it('offers Off and 1-24 hour choices only', async () => {
    render(<ReticulumIdentitySection sourceId="src-rns" canWrite />);
    await screen.findByDisplayValue('Base Camp');
    const values = Array.from((screen.getByRole('combobox') as HTMLSelectElement).options).map(o => Number(o.value));
    expect(values[0]).toBe(0);
    for (const v of values.slice(1)) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(24);
    }
  });

  it('Announce now posts once and then counts down', async () => {
    const user = userEvent.setup();
    render(<ReticulumIdentitySection sourceId="src-rns" canWrite />);
    await screen.findByText(HASH);
    expect(announceBtn().disabled).toBe(false);
    apiGet.mockResolvedValue(settings({ cooldownRemainingSeconds: 60, lastAnnounceAt: Date.now() }));
    await user.click(announceBtn());
    expect(apiPost).toHaveBeenCalledWith('/api/sources/src-rns/reticulum/announce');
    await waitFor(() => expect(announceBtn().disabled).toBe(true));
    expect(announceBtn().textContent).toMatch(/60 s/);
  });

  it('Announce now is disabled while the server reports a cooldown', async () => {
    apiGet.mockResolvedValue(settings({ cooldownRemainingSeconds: 37 }));
    render(<ReticulumIdentitySection sourceId="src-rns" canWrite />);
    await screen.findByText(HASH);
    await waitFor(() => expect(announceBtn().disabled).toBe(true));
    expect(announceBtn().textContent).toMatch(/37 s/);
  });

  it('a 429 from the server disables the button for retryAfterSeconds', async () => {
    const user = userEvent.setup();
    apiPost.mockRejectedValue(Object.assign(new Error('cooldown'), { status: 429, retryAfterSeconds: 25 }));
    render(<ReticulumIdentitySection sourceId="src-rns" canWrite />);
    await screen.findByText(HASH);
    await user.click(announceBtn());
    await waitFor(() => expect(announceBtn().disabled).toBe(true));
    expect(announceBtn().textContent).toMatch(/2[45] s/);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Announce now is disabled while disconnected, but the name can still be saved', async () => {
    const user = userEvent.setup();
    apiGet.mockResolvedValue(settings({ connected: false, destinationHash: null }));
    apiPut.mockResolvedValue({ success: true, data: { applied: false } });
    render(<ReticulumIdentitySection sourceId="src-rns" canWrite />);
    const input = await screen.findByDisplayValue('Base Camp');
    expect(screen.getByText(/not connected/i)).toBeTruthy();
    expect(announceBtn().disabled).toBe(true);
    await user.type(input, '!');
    await user.click(saveBtn());
    await waitFor(() => expect(screen.getByText(/next connects/i)).toBeTruthy());
  });

  it('without configuration:write every control is disabled', async () => {
    render(<ReticulumIdentitySection sourceId="src-rns" canWrite={false} />);
    const input = (await screen.findByDisplayValue('Base Camp')) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
    expect(saveBtn().disabled).toBe(true);
    expect(announceBtn().disabled).toBe(true);
  });
});

describe('ReticulumConfigurationView outside own mode (#6011)', () => {
  it('shows the identity section and skips the RNode radio routes', async () => {
    render(<ReticulumConfigurationView sourceId="src-rns" showRadio={false} />);
    expect(await screen.findByText(HASH)).toBeTruthy();
    expect(apiGet).not.toHaveBeenCalledWith(expect.stringContaining('/radio-config'));
    expect(apiGet).not.toHaveBeenCalledWith(expect.stringContaining('/device-info'));
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
  });
});
