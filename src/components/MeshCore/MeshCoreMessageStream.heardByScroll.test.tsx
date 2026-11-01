/**
 * @vitest-environment jsdom
 *
 * #6124: clicking the heard-by (antenna) badge expands the repeater list and
 * scrolls the row into view, but only on expand — a collapse must not scroll.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

function channelSend(overrides: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return {
    id: 'sent-1',
    fromPublicKey: SELF,
    toPublicKey: 'channel-1',
    text: 'anyone out there?',
    timestamp: T0,
    heardBy: [{ hash: '7f', name: 'Hilltop', snr: 4 }],
    ...overrides,
  };
}

const heardBadge = () => screen.getByTitle('Repeaters that relayed this message');

describe('MeshCoreMessageStream heard-by scroll into view (#6124)', () => {
  // jsdom does not implement scrollIntoView, so install a mock on the prototype
  // (spyOn would throw on the missing property) and restore the original after.
  const original = Element.prototype.scrollIntoView;
  let scrollSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it('scrolls the row into view with block:nearest when the list expands', () => {
    render(
      <MeshCoreMessageStream messages={[channelSend()]} selfPublicKey={SELF} onSend={async () => true} />,
    );

    // Nothing scrolled on initial render.
    expect(scrollSpy).not.toHaveBeenCalled();

    fireEvent.click(heardBadge());

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' });

    // The call targets the row carrying the message id.
    const row = document.querySelector('[data-message-id="sent-1"]');
    expect(row).not.toBeNull();
    expect(scrollSpy.mock.instances[0]).toBe(row);
  });

  it('does not scroll when the list collapses', () => {
    render(
      <MeshCoreMessageStream messages={[channelSend()]} selfPublicKey={SELF} onSend={async () => true} />,
    );

    fireEvent.click(heardBadge()); // expand
    expect(scrollSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(heardBadge()); // collapse
    expect(scrollSpy).toHaveBeenCalledTimes(1); // unchanged
  });
});
