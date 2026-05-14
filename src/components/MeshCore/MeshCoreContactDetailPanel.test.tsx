/**
 * @vitest-environment jsdom
 *
 * Smoke tests for the MeshCore DM contact-detail panel.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
