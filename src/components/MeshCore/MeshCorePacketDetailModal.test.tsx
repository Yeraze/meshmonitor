/**
 * @vitest-environment jsdom
 *
 * Smoke tests for the MeshCore packet-decode modal: confirms the decoder output
 * is surfaced in the UI for an ADVERT packet and an encrypted TXT_MSG.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import MeshCorePacketDetailModal from './MeshCorePacketDetailModal';
import type { MeshCoreOtaPacketEvent } from '../../hooks/useWebSocket';
import { buildGrpTxtFrame, buildGrpDataFrame } from '../../server/test-helpers/meshcoreFrames';
import { decodeMeshCorePacket } from '../../utils/meshcorePacketDecode';

const decodeMeshCoreGroupPacket = vi.fn();
vi.mock('../../services/api', () => ({
  default: { decodeMeshCoreGroupPacket: (...a: unknown[]) => decodeMeshCoreGroupPacket(...a) },
}));

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

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
    expect(document.querySelector('[data-ui-icon="encrypted"]')).toBeTruthy();
  });

  it('renders a no-raw notice when rawHex is empty', () => {
    render(<MeshCorePacketDetailModal packet={baseEvent({ rawHex: '' })} onClose={vi.fn()} />);
    expect(screen.getByText('No raw packet bytes available to decode.')).toBeTruthy();
  });
});

/**
 * GRP_TXT / GRP_DATA (#5567, #5568). The frames are really encrypted; the
 * server call is mocked, since the browser never holds a key.
 */
describe('MeshCorePacketDetailModal: group packets', () => {
  const SECRET = '0123456789abcdef0123456789abcdef';
  const TXT = buildGrpTxtFrame(1_700_000_000, 'Alice: hello mesh', SECRET);
  const group = decodeMeshCorePacket(TXT)!.payload.groupText!;
  const txtEvent = () => baseEvent({ payloadType: 0x05, rawHex: TXT, payloadSize: TXT.length / 2 });

  beforeEach(() => {
    decodeMeshCoreGroupPacket.mockReset();
  });

  it('labels the frame as channel hash / cipher MAC / ciphertext, not dest/src hash', async () => {
    decodeMeshCoreGroupPacket.mockResolvedValue({ decrypted: false, payloadType: 5, channelHash: group.channelHash });
    render(<MeshCorePacketDetailModal packet={txtEvent()} sourceId="src-a" onClose={vi.fn()} />);
    expect(screen.getByText('Channel hash')).toBeTruthy();
    expect(screen.getByText(`0x${group.channelHash}`)).toBeTruthy();
    expect(screen.getByText('Cipher MAC')).toBeTruthy();
    expect(screen.getByText(group.cipherMacHex)).toBeTruthy();
    expect(screen.getByText('Ciphertext')).toBeTruthy();
    expect(screen.queryByText('Dest hash')).toBeNull();
    expect(screen.queryByText('Src hash')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('mcpm-unknown-channel')).toBeTruthy());
  });

  it('asks the server with the source and raw frame, showing a loading state first', async () => {
    let resolve!: (v: unknown) => void;
    decodeMeshCoreGroupPacket.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<MeshCorePacketDetailModal packet={txtEvent()} sourceId="src-a" onClose={vi.fn()} />);
    expect(screen.getByText('Decrypting…')).toBeTruthy();
    expect(decodeMeshCoreGroupPacket).toHaveBeenCalledWith('src-a', TXT);
    resolve({
      decrypted: true, payloadType: 5, channelHash: group.channelHash, channelName: 'ops',
      keyOrigin: { kind: 'source', sourceName: 'Companion', currentSource: false },
      text: { sender: 'Alice', timestampSec: 1_700_000_000, text: 'hello mesh' },
    });
    await waitFor(() => expect(screen.getByText('hello mesh')).toBeTruthy());
    expect(screen.queryByText('Decrypting…')).toBeNull();
    expect(screen.getByText('ops')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('key from source Companion')).toBeTruthy();
    expect(screen.getByText(new Date(1_700_000_000_000).toLocaleString())).toBeTruthy();
    expect(screen.queryByTestId('mcpm-unknown-channel')).toBeNull();
    // The ciphertext stays on screen under the plaintext.
    expect(screen.getByText(group.ciphertextHex)).toBeTruthy();
  });

  it('names a virtual-channel key and a key on this source', async () => {
    decodeMeshCoreGroupPacket.mockResolvedValue({
      decrypted: true, payloadType: 5, channelHash: group.channelHash, channelName: 'vc',
      keyOrigin: { kind: 'virtual' }, text: { sender: null, timestampSec: 0, text: 'x y z' },
    });
    const first = render(<MeshCorePacketDetailModal packet={txtEvent()} sourceId="src-a" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('virtual channel')).toBeTruthy());
    expect(screen.getByText('(not given)')).toBeTruthy();
    first.unmount();

    decodeMeshCoreGroupPacket.mockResolvedValue({
      decrypted: true, payloadType: 5, channelHash: group.channelHash, channelName: '',
      keyOrigin: { kind: 'source', sourceName: 'Here', currentSource: true },
      text: { sender: 'Bob', timestampSec: 5, text: 'local' },
    });
    render(<MeshCorePacketDetailModal packet={txtEvent()} sourceId="src-a" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('this source')).toBeTruthy());
    expect(screen.getByText('(unnamed)')).toBeTruthy();
  });

  it('shows "Unknown channel (hash 0xNN)" when the server cannot or may not open it', async () => {
    decodeMeshCoreGroupPacket.mockResolvedValue({ decrypted: false, payloadType: 5, channelHash: group.channelHash });
    render(<MeshCorePacketDetailModal packet={txtEvent()} sourceId="src-a" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(`Unknown channel (hash 0x${group.channelHash})`)).toBeTruthy());
    expect(screen.queryByTestId('mcpm-plaintext')).toBeNull();
  });

  it('shows an error state when the request fails, and keeps the ciphertext', async () => {
    decodeMeshCoreGroupPacket.mockRejectedValue(new Error('boom'));
    render(<MeshCorePacketDetailModal packet={txtEvent()} sourceId="src-a" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('Could not ask the server to decrypt this packet.')).toBeTruthy();
    expect(screen.getByText(group.ciphertextHex)).toBeTruthy();
  });

  it('renders a GRP_DATA body as a hex + ASCII dump', async () => {
    const body = Buffer.from('sensor=42\x00\xff', 'latin1');
    const raw = buildGrpDataFrame(0x1234, body, SECRET);
    const g = decodeMeshCorePacket(raw)!.payload.groupData!;
    decodeMeshCoreGroupPacket.mockResolvedValue({
      decrypted: true, payloadType: 6, channelHash: g.channelHash, channelName: 'telemetry',
      keyOrigin: { kind: 'source', sourceName: 'Here', currentSource: true },
      data: { dataType: 0x1234, dataHex: body.toString('hex') },
    });
    render(
      <MeshCorePacketDetailModal
        packet={baseEvent({ payloadType: 0x06, rawHex: raw, payloadSize: raw.length / 2 })}
        sourceId="src-a"
        onClose={vi.fn()}
      />,
    );
    expect(decodeMeshCoreGroupPacket).toHaveBeenCalledWith('src-a', raw);
    await waitFor(() => expect(screen.getByText('telemetry')).toBeTruthy());
    expect(screen.getByText('0x1234')).toBeTruthy();
    expect(screen.getByText('11 B')).toBeTruthy();
    const dump = document.querySelector('pre:not(.mcpm-raw-hex)')!.textContent!;
    expect(dump).toContain('0000  73 65 6e 73 6f 72 3d 34 32 00 ff');
    expect(dump).toContain('sensor=42..');
    expect(screen.queryByText('Dest hash')).toBeNull();
  });

  it('does not call the server for a non-group packet, or without a source', () => {
    const parts = [(0x02 << 2) | 0x02, 0xff, 0x12, 0x34, 0xde, 0xad];
    const rawHex = parts.map((b) => b.toString(16).padStart(2, '0')).join('');
    render(<MeshCorePacketDetailModal packet={baseEvent({ payloadType: 0x02, rawHex })} sourceId="src-a" onClose={vi.fn()} />);
    render(<MeshCorePacketDetailModal packet={txtEvent()} onClose={vi.fn()} />);
    expect(decodeMeshCoreGroupPacket).not.toHaveBeenCalled();
    // Without a source the group frame is still labelled, and stays ciphertext.
    expect(screen.getByTestId('mcpm-unknown-channel')).toBeTruthy();
  });
});

