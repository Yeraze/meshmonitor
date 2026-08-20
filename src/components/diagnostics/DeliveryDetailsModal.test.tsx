/**
 * @vitest-environment jsdom
 *
 * DeliveryDetailsModal (#4816 Phase 1, WP2) — a11y shell, provenance badges,
 * honest Unknown placeholders, and the MeshCore Propagation section's
 * raw-hash-always-visible + DM-omission rules.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DeliveryDetailsModal from './DeliveryDetailsModal';
import { MessageDeliveryState, type MeshMessage } from '../../types/message';
import type { MeshCoreMessage } from '../MeshCore/hooks/useMeshCore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

function buildMeshtasticMessage(overrides: Partial<MeshMessage> = {}): MeshMessage {
  return {
    id: 'mt1',
    from: '!aaaaaaaa',
    to: '!bbbbbbbb',
    fromNodeId: '!aaaaaaaa',
    toNodeId: '!bbbbbbbb',
    text: 'hello',
    channel: -1,
    timestamp: new Date(),
    deliveryState: MessageDeliveryState.CONFIRMED,
    requestId: 12345,
    ackFromNode: 999,
    hopStart: 3,
    hopLimit: 1,
    relayNode: 0x4a,
    rxSnr: 8.5,
    rxRssi: -70,
    xeddsaSigned: true,
    wantAck: true,
    viaMqtt: false,
    ...overrides,
  };
}

function buildMeshCoreMessage(overrides: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return {
    id: 'mc1',
    fromPublicKey: 'abcd1234',
    text: 'hi',
    timestamp: Date.now(),
    deliveryStatus: 'delivered',
    roundTripMs: 1200,
    expectedAckCrc: 0xab,
    hopCount: 0,
    ...overrides,
  };
}

describe('DeliveryDetailsModal', () => {
  it('renders as an accessible dialog with protocol + status for a Meshtastic message', () => {
    render(
      <DeliveryDetailsModal
        protocol="meshtastic"
        message={buildMeshtasticMessage()}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('Meshtastic')).toBeTruthy();
    // statusKey for a CONFIRMED DM, rendered raw by the mocked t() (no fallback).
    expect(screen.getByText('delivery_details.mt_status.confirmed_destination')).toBeTruthy();
  });

  it('shows a provenance badge per field and the honest Unknown placeholder for deferred fields', () => {
    render(
      <DeliveryDetailsModal
        protocol="meshtastic"
        message={buildMeshtasticMessage()}
        onClose={vi.fn()}
      />,
    );

    // Every rendered field carries a provenance badge; "Reported by protocol"
    // appears for several wire-sourced fields (requestId, ackFromNode, hopStart, ...).
    expect(screen.getAllByText('Reported by protocol').length).toBeGreaterThan(0);

    // protocol_result (exact routing code) and store_forward are ALWAYS
    // provenance:'unknown' + value:null this phase — never guessed.
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
  });

  it('renders MeshCore protocol + status and omits Propagation for a DM (no toPublicKey re-flood signal)', () => {
    render(
      <DeliveryDetailsModal
        protocol="meshcore"
        message={buildMeshCoreMessage({ toPublicKey: 'deadbeef' })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('MeshCore')).toBeTruthy();
    expect(screen.getByText('delivery_details.mc_status.delivered')).toBeTruthy();
    expect(screen.queryByText('Propagation (Heard By)')).toBeNull();
  });

  it('shows an honest "no re-flood observed" for a channel message with an empty heard-by list', () => {
    render(
      <DeliveryDetailsModal
        protocol="meshcore"
        message={buildMeshCoreMessage()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Propagation (Heard By)')).toBeTruthy();
    expect(screen.getByText('No re-flood observed')).toBeTruthy();
  });

  it('shows the RAW HASH for an unresolved relay and the honest re-flood subtitle for a channel message', () => {
    render(
      <DeliveryDetailsModal
        protocol="meshcore"
        message={buildMeshCoreMessage({
          heardBy: [
            { hash: 'a3f2', name: null, snr: 6.5 },
            { hash: '7fbe', name: 'Repeater-1', snr: 4.2 },
          ],
        })}
        onClose={vi.fn()}
      />,
    );

    // Unresolved relay: name is null, so the raw hash MUST be shown — never blank.
    expect(screen.getByText('a3f2')).toBeTruthy();
    // Resolved relay: name wins over hash.
    expect(screen.getByText('Repeater-1')).toBeTruthy();
    expect(screen.getByText(/Observed by MeshMonitor through repeater re-flood correlation/)).toBeTruthy();
    expect(screen.getByText(/NOT recipient-specific proof of delivery/)).toBeTruthy();
  });

  it('calls onClose on Escape, overlay click, and the close button', () => {
    const onCloseEscape = vi.fn();
    const { unmount } = render(
      <DeliveryDetailsModal protocol="meshtastic" message={buildMeshtasticMessage()} onClose={onCloseEscape} />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCloseEscape).toHaveBeenCalledTimes(1);
    unmount();

    const onCloseOverlay = vi.fn();
    const { getByRole: getByRoleOverlay, unmount: unmountOverlay } = render(
      <DeliveryDetailsModal protocol="meshtastic" message={buildMeshtasticMessage()} onClose={onCloseOverlay} />,
    );
    fireEvent.click(getByRoleOverlay('presentation'));
    expect(onCloseOverlay).toHaveBeenCalledTimes(1);
    unmountOverlay();

    const onCloseButton = vi.fn();
    render(<DeliveryDetailsModal protocol="meshtastic" message={buildMeshtasticMessage()} onClose={onCloseButton} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCloseButton).toHaveBeenCalledTimes(1);
  });

  it('does not close when clicking inside the dialog content', () => {
    const onClose = vi.fn();
    render(<DeliveryDetailsModal protocol="meshtastic" message={buildMeshtasticMessage()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
