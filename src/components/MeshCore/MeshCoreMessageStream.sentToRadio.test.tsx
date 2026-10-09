/**
 * @vitest-environment jsdom
 *
 * Delivery marks on our own MeshCore messages (#5682).
 *
 * A channel send that no repeater was heard relaying used to show nothing at
 * all. It now reads "Sent to radio": the radio accepted the message. MeshCore
 * radios do not report transmitting, so the mark claims no more than that and
 * must not look like the heard-by badge a relay earns.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../diagnostics/MessageDetailsModal', () => ({
  default: ({ message }: { message: { id: string } }) => <div data-testid="details-modal">{message.id}</div>,
}));

import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import type { MeshCoreMessage } from './hooks/useMeshCore';

const SELF = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

function channelSend(overrides: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return {
    id: 'sent-1',
    fromPublicKey: SELF,
    toPublicKey: 'channel-1',
    text: 'anyone out there?',
    timestamp: T0,
    ...overrides,
  };
}

function renderStream(messages: MeshCoreMessage[]) {
  return render(
    <MeshCoreMessageStream messages={messages} selfPublicKey={SELF} onSend={async () => true} />,
  );
}

const sentMark = () => screen.queryByRole('button', { name: 'Sent to radio' });
const heardBadge = () => screen.queryByTitle('Repeaters that relayed this message');

describe('MeshCoreMessageStream delivery marks (#5682)', () => {
  it('marks our unrelayed channel send "Sent to radio" and says what that means', () => {
    renderStream([channelSend()]);
    const mark = sentMark();
    expect(mark).not.toBeNull();
    // The limits of the claim are in the tooltip, in plain words.
    expect(mark!.getAttribute('title')).toMatch(/accepted this message for sending/);
    expect(mark!.getAttribute('title')).toMatch(/do not report when they transmit/);
    expect(mark!.getAttribute('title')).toMatch(/cannot tell whether it went out or whether anyone heard it/);
    // Not drawn as a relay, and never as "0 hops".
    expect(heardBadge()).toBeNull();
    expect(screen.queryByText(/hops?\b/)).toBeNull();
  });

  it('shows the same mark for a row loaded from history (no live-only fields)', () => {
    renderStream([channelSend({ id: 'old', timestamp: T0 - 7 * 24 * 3600_000, receivedAt: T0 - 7 * 24 * 3600_000 })]);
    expect(sentMark()).not.toBeNull();
  });

  it('a relay replaces the mark with the heard-by badge', () => {
    const { rerender } = renderStream([channelSend()]);
    expect(sentMark()).not.toBeNull();

    rerender(
      <MeshCoreMessageStream
        messages={[channelSend({ heardBy: [{ hash: '7f', name: 'Hilltop', snr: 4 }] })]}
        selfPublicKey={SELF}
        onSend={async () => true}
      />,
    );
    expect(sentMark()).toBeNull();
    const badge = heardBadge();
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('1');
  });

  it('shows no mark on a received channel message, even one with the same text', () => {
    renderStream([{ id: 'rx', fromPublicKey: 'channel-1', fromName: 'Other', text: 'anyone out there?', timestamp: T0 }]);
    expect(sentMark()).toBeNull();
  });

  it('shows no mark on a room post', () => {
    renderStream([channelSend({ toPublicKey: PEER, messageType: 'room_post' })]);
    expect(sentMark()).toBeNull();
  });

  it('leaves DMs on their own ack states', () => {
    renderStream([
      channelSend({ id: 'dm-sent', toPublicKey: PEER, expectedAckCrc: 1, deliveryStatus: 'sent' }),
      channelSend({ id: 'dm-ok', toPublicKey: PEER, expectedAckCrc: 2, deliveryStatus: 'delivered', roundTripMs: 900 }),
      channelSend({ id: 'dm-bad', toPublicKey: PEER, expectedAckCrc: 3, deliveryStatus: 'failed' }),
    ]);
    expect(sentMark()).toBeNull();
    expect(screen.getByRole('button', { name: 'Sent, awaiting confirmation' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delivered (900ms)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delivery failed' })).toBeTruthy();
  });

  it('shows nothing when our own key is unknown (cannot tell which rows are ours)', () => {
    render(<MeshCoreMessageStream messages={[channelSend()]} onSend={async () => true} />);
    expect(sentMark()).toBeNull();
  });

  it('opens Delivery Details for that message', () => {
    renderStream([channelSend({ id: 'a' }), channelSend({ id: 'b', text: 'second' })]);
    const row = document.querySelector('[data-message-id="b"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Sent to radio' }));
    expect(screen.getByTestId('details-modal').textContent).toBe('b');
  });
});
