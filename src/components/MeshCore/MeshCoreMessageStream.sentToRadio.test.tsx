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

describe('MeshCoreMessageStream delivery marks (#5682, #6193)', () => {
  it('shows the heard-by antenna (count 0) on our unrelayed channel send, not "Sent to radio"', () => {
    renderStream([channelSend()]);
    // #6193: the "Sent to radio" text is dropped for channel sends.
    expect(sentMark()).toBeNull();
    // The antenna is there from the start, with a zero count.
    const badge = heardBadge();
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('0');
    // Never "0 hops".
    expect(screen.queryByText(/hops?\b/)).toBeNull();
  });

  it('shows the antenna on a channel row loaded from history (no live-only fields)', () => {
    renderStream([channelSend({ id: 'old', timestamp: T0 - 7 * 24 * 3600_000, receivedAt: T0 - 7 * 24 * 3600_000 })]);
    expect(sentMark()).toBeNull();
    expect(heardBadge()).not.toBeNull();
  });

  it('a relay raises the antenna count', () => {
    const { rerender } = renderStream([channelSend()]);
    expect(heardBadge()!.textContent).toContain('0');

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

  it('shows no antenna and no mark on a received channel message, even one with the same text', () => {
    renderStream([{ id: 'rx', fromPublicKey: 'channel-1', fromName: 'Other', text: 'anyone out there?', timestamp: T0 }]);
    expect(sentMark()).toBeNull();
    expect(heardBadge()).toBeNull();
  });

  describe('our own DMs and room posts', () => {
    const dm = (over: Partial<MeshCoreMessage> = {}) => channelSend({ toPublicKey: PEER, ...over });
    const post = (over: Partial<MeshCoreMessage> = {}) => dm({ messageType: 'room_post', ...over });
    const row = (id: string) => within(document.querySelector(`[data-message-id="${id}"]`) as HTMLElement);

    it('DM: "Sent to radio" while the ack is awaited, then a tick, or a warning', () => {
      renderStream([
        dm({ id: 'wait', expectedAckCrc: 1, deliveryStatus: 'sent' }),
        dm({ id: 'ok', expectedAckCrc: 2, deliveryStatus: 'delivered', roundTripMs: 900 }),
        dm({ id: 'bad', expectedAckCrc: 3, deliveryStatus: 'failed' }),
      ]);
      const waiting = row('wait').getByRole('button', { name: 'Sent to radio' });
      expect(waiting.getAttribute('data-send-state')).toBe('awaiting_ack');
      expect(waiting.getAttribute('title')).toMatch(/waiting for the recipient's radio to acknowledge/);
      expect(waiting.getAttribute('title')).toMatch(/do not report when they transmit/);

      expect(row('ok').queryByRole('button', { name: 'Sent to radio' })).toBeNull();
      const ok = row('ok').getByRole('button', { name: /^Delivered: the recipient's radio acknowledged this message \(900 ms\)\.$/ });
      expect(ok.className).toContain('mc-delivery-delivered');

      expect(row('bad').queryByRole('button', { name: 'Sent to radio' })).toBeNull();
      const bad = row('bad').getByRole('button', { name: /^Not confirmed: no acknowledgement arrived after all retries/ });
      expect(bad.className).toContain('mc-delivery-failed');
      expect(bad.getAttribute('title')).toMatch(/may still have arrived/);
    });

    it('DM with no ack state on record (history, or a restart mid-wait): "Sent to radio", no ack claimed', () => {
      renderStream([dm({ id: 'old' })]);
      const mark = row('old').getByRole('button', { name: 'Sent to radio' });
      expect(mark.getAttribute('data-send-state')).toBe('sent_to_radio');
      expect(mark.getAttribute('title')).toMatch(/has no acknowledgement on record/);
      expect(mark.getAttribute('title')).not.toMatch(/waiting/);
    });

    it('a delivered DM loaded from history has no round trip and prints none', () => {
      renderStream([dm({ id: 'ok', deliveryStatus: 'delivered' })]);
      const ok = row('ok').getByRole('button', { name: /^Delivered/ });
      expect(ok.getAttribute('title')).not.toMatch(/undefined|ms/);
    });

    it('room post: the same states, named for the room server', () => {
      renderStream([
        post({ id: 'none' }),
        post({ id: 'wait', expectedAckCrc: 1, deliveryStatus: 'sent' }),
        post({ id: 'ok', expectedAckCrc: 2, deliveryStatus: 'delivered', roundTripMs: 1200 }),
        post({ id: 'bad', expectedAckCrc: 3, deliveryStatus: 'failed' }),
      ]);
      const none = row('none').getByRole('button', { name: 'Sent to radio' });
      expect(none.getAttribute('title')).toMatch(/cannot tell whether the room server got it/);
      const waiting = row('wait').getByRole('button', { name: 'Sent to radio' });
      expect(waiting.getAttribute('title')).toMatch(/waiting for the room server to acknowledge/);
      expect(row('ok').getByRole('button', { name: 'The room server acknowledged this post (1200 ms).' })).toBeTruthy();
      const bad = row('bad').getByRole('button', { name: /^Not confirmed: the room server did not acknowledge this post in time/ });
      // Never the DM wording: a room post is not retried.
      expect(bad.getAttribute('title')).not.toMatch(/retries/);
    });

    it('DMs carry the heard-by antenna (#6194); room posts do not', () => {
      renderStream([dm({ id: 'a' }), post({ id: 'b' }), dm({ id: 'c', deliveryStatus: 'delivered' })]);
      // Our own DMs now get the same antenna/count bubble as channel sends.
      expect(row('a').getByTestId('mc-heard-by-badge')).toBeTruthy();
      expect(row('c').getByTestId('mc-heard-by-badge')).toBeTruthy();
      // Room posts stay excluded — the companion does not re-flood them back for us to hear.
      expect(row('b').queryByTestId('mc-heard-by-badge')).toBeNull();
      // A count-0 antenna prints no "hops" text until it is expanded.
      expect(screen.queryByText(/hops?\b/)).toBeNull();
    });

    it('shows no mark on a DM or room post we RECEIVED', () => {
      renderStream([
        { id: 'rx-dm', fromPublicKey: PEER, toPublicKey: SELF, text: 'hi', timestamp: T0 },
        { id: 'rx-post', fromPublicKey: PEER, toPublicKey: 'c'.repeat(64), messageType: 'room_post', text: 'hi', timestamp: T0 },
      ]);
      expect(sentMark()).toBeNull();
      expect(document.querySelector('.mc-delivery-status')).toBeNull();
    });

    it('the mark opens Delivery Details for that message', () => {
      renderStream([dm({ id: 'a' }), post({ id: 'b' })]);
      fireEvent.click(row('b').getByRole('button', { name: 'Sent to radio' }));
      expect(screen.getByTestId('details-modal').textContent).toBe('b');
    });
  });

  it('shows nothing when our own key is unknown (cannot tell which rows are ours)', () => {
    render(<MeshCoreMessageStream messages={[channelSend()]} onSend={async () => true} />);
    expect(sentMark()).toBeNull();
  });

  it('each of our channel sends carries its own heard-by antenna (#6193)', () => {
    renderStream([channelSend({ id: 'a' }), channelSend({ id: 'b', text: 'second' })]);
    for (const id of ['a', 'b']) {
      const row = within(document.querySelector(`[data-message-id="${id}"]`) as HTMLElement);
      expect(row.queryByRole('button', { name: 'Sent to radio' })).toBeNull();
      expect(row.getByTestId('mc-heard-by-badge')).toBeTruthy();
    }
  });
});
