/**
 * @vitest-environment jsdom
 *
 * Smoke tests for the MeshCore packet-decode modal: confirms the decoder output
 * is surfaced in the UI for an ADVERT packet and an encrypted TXT_MSG.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import MeshCorePacketDetailModal from './MeshCorePacketDetailModal';
import type { MeshCoreOtaPacketEvent } from '../../hooks/useWebSocket';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

// Build an ADVERT packet: FLOOD route, direct path, named REPEATER advert.
function buildAdvertHex(name: string): string {
  const parts: number[] = [];
  parts.push((0x04 << 2) | 0x01); // header: ADVERT + FLOOD
  parts.push(0xff); // pathLen: direct
  for (let i = 0; i < 32; i++) parts.push(i + 1); // pubkey
  parts.push(0x00, 0x5e, 0xd0, 0x65); // timestamp (LE) ~1.7e9
  for (let i = 0; i < 64; i++) parts.push(0xaa); // signature
  parts.push(0x80 | 0x02); // flags: NAME + advType REPEATER(2)
  for (const ch of name) parts.push(ch.charCodeAt(0));
  parts.push(0x00); // null terminator
  return parts.map((b) => b.toString(16).padStart(2, '0')).join('');
}

const baseEvent = (overrides: Partial<MeshCoreOtaPacketEvent>): MeshCoreOtaPacketEvent => ({
  timestamp: Date.now(),
  payloadType: 0x04,
  snr: 8.5,
  rssi: -72,
  payloadSize: 0,
  rawHex: '',
  ...overrides,
});

describe('MeshCorePacketDetailModal', () => {
  it('renders decoded ADVERT fields (name, type, public key)', () => {
    const rawHex = buildAdvertHex('Repeater-9');
    render(
      <MeshCorePacketDetailModal
        packet={baseEvent({ payloadType: 0x04, rawHex, payloadSize: rawHex.length / 2 })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Repeater-9')).toBeTruthy();
    expect(screen.getByText(/REPEATER/)).toBeTruthy();
    // Reception metadata is surfaced too.
    expect(screen.getByText('-72 dBm')).toBeTruthy();
  });

  it('shows plaintext dest/src hashes and an encrypted-body marker for TXT_MSG', () => {
    // header TXT_MSG+DIRECT, direct path, dest=0x12 src=0x34 + ciphertext
    const parts = [(0x02 << 2) | 0x02, 0xff, 0x12, 0x34, 0xde, 0xad];
    const rawHex = parts.map((b) => b.toString(16).padStart(2, '0')).join('');
    render(
      <MeshCorePacketDetailModal
        packet={baseEvent({ payloadType: 0x02, rawHex, payloadSize: parts.length })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('12')).toBeTruthy(); // dest hash
    expect(screen.getByText('34')).toBeTruthy(); // src hash
    expect(screen.getByText(/🔒/)).toBeTruthy(); // encrypted marker
  });

  it('renders a no-raw notice when rawHex is empty', () => {
    render(<MeshCorePacketDetailModal packet={baseEvent({ rawHex: '' })} onClose={vi.fn()} />);
    expect(screen.getByText('No raw packet bytes available to decode.')).toBeTruthy();
  });
});
