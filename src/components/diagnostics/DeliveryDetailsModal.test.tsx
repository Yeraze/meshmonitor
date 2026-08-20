/**
 * @vitest-environment jsdom
 *
 * DeliveryDetailsModal (#4816 Phase 1, WP2 + Phase 3 WP4 + Phase 4 WP4) —
 * a11y shell, provenance badges, honest Unknown placeholders, the MeshCore
 * Propagation section's raw-hash-always-visible + DM-omission rules, the
 * Meshtastic Propagation (Heard-By) section's honest partial-identity
 * rendering, and the persisted event Timeline section (populated / empty /
 * loading / error states).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import DeliveryDetailsModal from './DeliveryDetailsModal';
import { MessageDeliveryState, type MeshMessage, type MessageEvent } from '../../types/message';
import type { MeshCoreMessage } from '../MeshCore/hooks/useMeshCore';
import apiService from '../../services/api';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, vars?: Record<string, unknown>) => {
      if (typeof fallback !== 'string') return key;
      // Minimal {{var}} interpolation so possible_relays/attempt-style
      // fallbacks render their count in tests, matching real i18next.
      if (vars) {
        return fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? ''));
      }
      return fallback;
    },
  }),
}));

// The timeline section fetches via ApiService.getMessageEvents, and the
// Meshtastic Propagation section via ApiService.getMeshtasticHeardBy. Default
// both to empty; per-test overrides drive the populated/loading/error states.
vi.mock('../../services/api', () => ({
  default: {
    getMessageEvents: vi.fn().mockResolvedValue([]),
    getMeshtasticHeardBy: vi.fn().mockResolvedValue([]),
  },
}));

const mockGetMessageEvents = apiService.getMessageEvents as unknown as ReturnType<typeof vi.fn>;
const mockGetMeshtasticHeardBy = apiService.getMeshtasticHeardBy as unknown as ReturnType<typeof vi.fn>;

function renderModal(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(createElement(QueryClientProvider, { client }, ui));
}

beforeEach(() => {
  mockGetMessageEvents.mockReset();
  mockGetMessageEvents.mockResolvedValue([]);
  mockGetMeshtasticHeardBy.mockReset();
  mockGetMeshtasticHeardBy.mockResolvedValue([]);
});

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

function buildEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    id: 1,
    sourceId: 'source-a',
    messageId: 'mt1',
    eventType: 'submitted',
    provenance: 'observed',
    detail: null,
    timestamp: Date.parse('2026-01-01T10:00:00Z'),
    createdAt: Date.parse('2026-01-01T10:00:00Z'),
    ...overrides,
  };
}

describe('DeliveryDetailsModal', () => {
  it('renders as an accessible dialog with protocol + status for a Meshtastic message', () => {
    renderModal(
      <DeliveryDetailsModal
        protocol="meshtastic"
        sourceId="source-a"
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
    renderModal(
      <DeliveryDetailsModal
        protocol="meshtastic"
        sourceId="source-a"
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
    renderModal(
      <DeliveryDetailsModal
        protocol="meshcore"
        sourceId="source-a"
        message={buildMeshCoreMessage({ toPublicKey: 'deadbeef' })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('MeshCore')).toBeTruthy();
    expect(screen.getByText('delivery_details.mc_status.delivered')).toBeTruthy();
    expect(screen.queryByText('Propagation (Heard By)')).toBeNull();
  });

  it('shows an honest "no re-flood observed" for a channel message with an empty heard-by list', () => {
    renderModal(
      <DeliveryDetailsModal
        protocol="meshcore"
        sourceId="source-a"
        message={buildMeshCoreMessage()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Propagation (Heard By)')).toBeTruthy();
    expect(screen.getByText('No re-flood observed')).toBeTruthy();
  });

  it('shows the RAW HASH for an unresolved relay and the honest re-flood subtitle for a channel message', () => {
    renderModal(
      <DeliveryDetailsModal
        protocol="meshcore"
        sourceId="source-a"
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

  describe('Meshtastic Propagation section (#4816 Phase 4 WP4)', () => {
    it('renders honest partial-identity rows for a channel message: single/multi/zero candidates', async () => {
      mockGetMeshtasticHeardBy.mockResolvedValue([
        {
          relayByte: 0x4a,
          relayByteHex: '0x4A',
          snr: 6.5,
          heardAt: Date.parse('2026-01-01T10:00:00Z'),
          candidates: [{ nodeNum: 0x12345678, longName: 'Repeater-1' }],
        },
        {
          relayByte: 0x7b,
          relayByteHex: '0x7B',
          snr: null,
          heardAt: Date.parse('2026-01-01T10:01:00Z'),
          candidates: [
            { nodeNum: 1, longName: 'Node-One' },
            { nodeNum: 2, longName: 'Node-Two' },
          ],
        },
        {
          relayByte: 0x99,
          relayByteHex: '0x99',
          snr: 3,
          heardAt: Date.parse('2026-01-01T10:02:00Z'),
          candidates: [],
        },
      ]);

      renderModal(
        <DeliveryDetailsModal
          protocol="meshtastic"
          sourceId="source-a"
          message={buildMeshtasticMessage({ channel: 0 })}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => expect(screen.getByText('Repeater-1')).toBeTruthy());

      // Single candidate: the resolved node's name plus the raw hex.
      expect(screen.getByText('Repeater-1')).toBeTruthy();
      expect(screen.getByText('0x4A')).toBeTruthy();

      // Multiple candidates: MUST NOT assert a single node — count + raw hex only.
      expect(screen.getByText('2 possible relays')).toBeTruthy();
      expect(screen.getByText('0x7B')).toBeTruthy();
      expect(screen.queryByText('Node-One')).toBeNull();

      // Zero candidates: raw hex only, honestly labeled unknown.
      expect(screen.getByText('Unknown relay')).toBeTruthy();
      expect(screen.getByText('0x99')).toBeTruthy();

      // Every row carries the Observed provenance badge.
      expect(screen.getAllByText('Observed by MeshMonitor').length).toBeGreaterThanOrEqual(3);

      expect(mockGetMeshtasticHeardBy).toHaveBeenCalledWith('source-a', 'mt1');
    });

    it('shows the honest empty state for a channel message with no observed re-flood', async () => {
      mockGetMeshtasticHeardBy.mockResolvedValue([]);
      renderModal(
        <DeliveryDetailsModal
          protocol="meshtastic"
          sourceId="source-a"
          message={buildMeshtasticMessage({ channel: 0 })}
          onClose={vi.fn()}
        />,
      );
      expect(screen.getByText('Propagation (Heard By)')).toBeTruthy();
      await waitFor(() => expect(screen.getByText('No re-flood observed')).toBeTruthy());
    });

    it('shows the loading state while heard-by is in flight', () => {
      mockGetMeshtasticHeardBy.mockReturnValue(new Promise(() => {}));
      renderModal(
        <DeliveryDetailsModal
          protocol="meshtastic"
          sourceId="source-a"
          message={buildMeshtasticMessage({ channel: 0 })}
          onClose={vi.fn()}
        />,
      );
      expect(screen.getByText('Checking observed propagation…')).toBeTruthy();
    });

    it('shows the honest error state when the heard-by fetch fails', async () => {
      mockGetMeshtasticHeardBy.mockRejectedValue(new Error('boom'));
      renderModal(
        <DeliveryDetailsModal
          protocol="meshtastic"
          sourceId="source-a"
          message={buildMeshtasticMessage({ channel: 0 })}
          onClose={vi.fn()}
        />,
      );
      await waitFor(() => expect(screen.getByText('Heard-by data unavailable')).toBeTruthy());
    });

    it('omits Propagation entirely for a Meshtastic direct message (channel === -1)', () => {
      renderModal(
        <DeliveryDetailsModal
          protocol="meshtastic"
          sourceId="source-a"
          message={buildMeshtasticMessage({ channel: -1 })}
          onClose={vi.fn()}
        />,
      );
      expect(screen.queryByText('Propagation (Heard By)')).toBeNull();
      expect(mockGetMeshtasticHeardBy).not.toHaveBeenCalled();
    });

    it('omits Propagation when the channel is undefined (not treated as a channel message)', () => {
      renderModal(
        <DeliveryDetailsModal
          protocol="meshtastic"
          sourceId="source-a"
          message={buildMeshtasticMessage({ channel: undefined })}
          onClose={vi.fn()}
        />,
      );
      expect(screen.queryByText('Propagation (Heard By)')).toBeNull();
      expect(mockGetMeshtasticHeardBy).not.toHaveBeenCalled();
    });
  });

  it('calls onClose on Escape, overlay click, and the close button', () => {
    const onCloseEscape = vi.fn();
    const { unmount } = renderModal(
      <DeliveryDetailsModal protocol="meshtastic" sourceId="source-a" message={buildMeshtasticMessage()} onClose={onCloseEscape} />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCloseEscape).toHaveBeenCalledTimes(1);
    unmount();

    const onCloseOverlay = vi.fn();
    const { getByRole: getByRoleOverlay, unmount: unmountOverlay } = renderModal(
      <DeliveryDetailsModal protocol="meshtastic" sourceId="source-a" message={buildMeshtasticMessage()} onClose={onCloseOverlay} />,
    );
    fireEvent.click(getByRoleOverlay('presentation'));
    expect(onCloseOverlay).toHaveBeenCalledTimes(1);
    unmountOverlay();

    const onCloseButton = vi.fn();
    renderModal(<DeliveryDetailsModal protocol="meshtastic" sourceId="source-a" message={buildMeshtasticMessage()} onClose={onCloseButton} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCloseButton).toHaveBeenCalledTimes(1);
  });

  it('does not close when clicking inside the dialog content', () => {
    const onClose = vi.fn();
    renderModal(<DeliveryDetailsModal protocol="meshtastic" sourceId="source-a" message={buildMeshtasticMessage()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  describe('Timeline section (#4816 Phase 3 WP4)', () => {
    it('renders event rows chronologically with provenance badges and a named routing_error detail', async () => {
      mockGetMessageEvents.mockResolvedValue([
        buildEvent({ id: 1, eventType: 'submitted', provenance: 'observed', timestamp: Date.parse('2026-01-01T10:00:00Z') }),
        buildEvent({ id: 2, eventType: 'delivered', provenance: 'reported', timestamp: Date.parse('2026-01-01T10:00:05Z') }),
        buildEvent({
          id: 3,
          eventType: 'routing_error',
          provenance: 'reported',
          detail: JSON.stringify({ routingErrorCode: 5 }),
          timestamp: Date.parse('2026-01-01T10:00:10Z'),
        }),
      ]);

      renderModal(
        <DeliveryDetailsModal
          protocol="meshtastic"
          sourceId="source-a"
          message={buildMeshtasticMessage()}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => expect(screen.getByText('Submitted')).toBeTruthy());

      const items = screen.getAllByRole('listitem');
      // Timeline is an <ol> of <li>; the three event rows render in order.
      const timelineRows = items.filter((li) =>
        ['Submitted', 'Delivered to mesh', 'Routing error'].some((label) =>
          li.textContent?.includes(label),
        ),
      );
      expect(timelineRows.length).toBe(3);
      expect(timelineRows[0].textContent).toContain('Submitted');
      expect(timelineRows[1].textContent).toContain('Delivered to mesh');
      expect(timelineRows[2].textContent).toContain('Routing error');

      // routing_error names the numeric code via the shared frontend map.
      expect(screen.getByText('MAX_RETRANSMIT (5)')).toBeTruthy();

      // Provenance badges reuse the Phase 1 badge labels (also present on the
      // description-section field rows, so assert presence, not uniqueness).
      expect(screen.getAllByText('Observed by MeshMonitor').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Reported by protocol').length).toBeGreaterThan(0);

      expect(mockGetMessageEvents).toHaveBeenCalledWith('source-a', 'mt1');
    });

    it('shows the honest empty state when no events are recorded', async () => {
      mockGetMessageEvents.mockResolvedValue([]);
      renderModal(
        <DeliveryDetailsModal
          protocol="meshtastic"
          sourceId="source-a"
          message={buildMeshtasticMessage()}
          onClose={vi.fn()}
        />,
      );
      await waitFor(() => expect(screen.getByText('No timeline recorded')).toBeTruthy());
    });

    it('shows the loading state while the timeline is in flight', () => {
      // Never-resolving promise keeps the query pending.
      mockGetMessageEvents.mockReturnValue(new Promise(() => {}));
      renderModal(
        <DeliveryDetailsModal
          protocol="meshtastic"
          sourceId="source-a"
          message={buildMeshtasticMessage()}
          onClose={vi.fn()}
        />,
      );
      expect(screen.getByText('Loading timeline…')).toBeTruthy();
    });

    it('shows the honest error state when the fetch fails', async () => {
      mockGetMessageEvents.mockRejectedValue(new Error('boom'));
      renderModal(
        <DeliveryDetailsModal
          protocol="meshtastic"
          sourceId="source-a"
          message={buildMeshtasticMessage()}
          onClose={vi.fn()}
        />,
      );
      await waitFor(() => expect(screen.getByText('Timeline unavailable')).toBeTruthy());
    });
  });
});
