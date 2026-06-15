/**
 * @vitest-environment jsdom
 *
 * Smoke tests for the MeshCore DM contact-detail panel.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreContactDetailPanel } from './MeshCoreContactDetailPanel';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

const PK = 'a'.repeat(64);

describe('MeshCoreContactDetailPanel', () => {
  it('renders the public key when a contact is provided', () => {
    const contact: MeshCoreContact = {
      publicKey: PK,
      advName: 'Companion Bob',
      advType: 1,
      rssi: -72,
      snr: 8.5,
      pathLen: 2,
      lastSeen: Date.now(),
      latitude: 30.123,
      longitude: -90.456,
    };

    render(<MeshCoreContactDetailPanel contact={contact} publicKey={PK} />);

    expect(screen.getByText('Companion Bob')).toBeTruthy();
    expect(screen.getByText('-72 dBm')).toBeTruthy();
    expect(screen.getByText('8.5 dB')).toBeTruthy();
    expect(screen.getByText(PK)).toBeTruthy();
    expect(screen.getByText('30.12300, -90.45600')).toBeTruthy();
  });

  it('falls back to truncated key as name when contact is null', () => {
    render(<MeshCoreContactDetailPanel contact={null} publicKey={PK} />);
    // First 8 hex chars with an ellipsis suffix
    expect(screen.getByText(`${PK.substring(0, 8)}…`)).toBeTruthy();
    expect(screen.getByText(PK)).toBeTruthy();
  });

  it('renders Direct when pathLen is 0', () => {
    const contact: MeshCoreContact = {
      publicKey: PK,
      pathLen: 0,
    };
    render(<MeshCoreContactDetailPanel contact={contact} publicKey={PK} />);
    expect(screen.getByText('Direct')).toBeTruthy();
  });

  it('renders Discover Path button when onDiscoverPath is provided and canWriteNodes is true', () => {
    const contact: MeshCoreContact = { publicKey: PK, advType: 1 };
    render(
      <MeshCoreContactDetailPanel
        contact={contact}
        publicKey={PK}
        onDiscoverPath={vi.fn().mockResolvedValue(true)}
        canWriteNodes
        isCompanion
      />,
    );
    expect(screen.getByRole('button', { name: 'Discover Path' })).toBeTruthy();
  });

  it('does not render Discover Path button when canWriteNodes is false', () => {
    const contact: MeshCoreContact = { publicKey: PK, advType: 1 };
    render(
      <MeshCoreContactDetailPanel
        contact={contact}
        publicKey={PK}
        onDiscoverPath={vi.fn().mockResolvedValue(true)}
        canWriteNodes={false}
        isCompanion
      />,
    );
    expect(screen.queryByRole('button', { name: 'Discover Path' })).toBeNull();
  });

  it('surfaces the real server error from onShareContact (issue #3480)', async () => {
    const contact: MeshCoreContact = { publicKey: PK, advType: 1 };
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const serverError = 'Device rejected share-contact — the firmware may not support this command.';
    const onShareContact = vi.fn().mockResolvedValue({ ok: false, error: serverError });

    render(
      <MeshCoreContactDetailPanel
        contact={contact}
        publicKey={PK}
        onShareContact={onShareContact}
        canWriteNodes
        isCompanion
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Share Contact' }));

    // The real reason is shown, NOT the hardcoded generic fallback.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(serverError);
    expect(onShareContact).toHaveBeenCalledWith(PK);

    confirmSpy.mockRestore();
  });

  it('falls back to a generic message when onShareContact returns no error text', async () => {
    const contact: MeshCoreContact = { publicKey: PK, advType: 1 };
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onShareContact = vi.fn().mockResolvedValue({ ok: false });

    render(
      <MeshCoreContactDetailPanel
        contact={contact}
        publicKey={PK}
        onShareContact={onShareContact}
        canWriteNodes
        isCompanion
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Share Contact' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Share contact failed.'));

    confirmSpy.mockRestore();
  });
});
