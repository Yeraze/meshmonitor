/**
 * @vitest-environment jsdom
 *
 * Receipt time and sender clock offset (#5973): a DM or channel row shows the
 * time MeshMonitor received it, then the sender's offset in parentheses. An
 * offset under 5 s, or on a room post, is not shown.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import type { MeshCoreMessage } from './hooks/useMeshCore';

const SELF = 'aa'.repeat(32);
// A whole second, an hour ago, so the ±24 h check passes against it.
const RECEIPT = Math.floor((Date.now() - 3_600_000) / 1000) * 1000;
const SEC = RECEIPT / 1000;

function timeCell(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector(`[data-message-id="${id}"] .mc-message-time`);
  if (!el) throw new Error(`no time cell for ${id}`);
  return el as HTMLElement;
}

describe('MeshCoreMessageStream receipt time + clock offset (#5973)', () => {
  it('shows the receipt time and a slow sender\'s offset', () => {
    const msg: MeshCoreMessage = {
      id: 'slow', fromPublicKey: 'channel-0', fromName: 'Slow', text: 'hi',
      timestamp: (SEC - 930) * 1000, senderTimestamp: SEC - 930, receivedAt: RECEIPT,
    };
    const { container } = render(
      <MeshCoreMessageStream messages={[msg]} selfPublicKey={SELF} onSend={async () => true} />,
    );
    const cell = timeCell(container, 'slow');
    expect(cell.textContent).toContain(new Date(RECEIPT).toLocaleTimeString());
    expect(cell.textContent).not.toContain(new Date((SEC - 930) * 1000).toLocaleTimeString());
    const badge = cell.querySelector('[data-testid="mc-clock-offset"]');
    expect(badge?.textContent).toBe('(+15m30s)');
    expect(badge?.getAttribute('title')).toBeTruthy();
  });

  it('shows a negative offset for a fast sender', () => {
    const msg: MeshCoreMessage = {
      id: 'fast', fromPublicKey: 'bb'.repeat(6), toPublicKey: SELF, text: 'dm',
      timestamp: (SEC + 930) * 1000, senderTimestamp: SEC + 930, receivedAt: RECEIPT,
    };
    const { container } = render(
      <MeshCoreMessageStream messages={[msg]} selfPublicKey={SELF} onSend={async () => true} />,
    );
    expect(timeCell(container, 'fast').querySelector('[data-testid="mc-clock-offset"]')?.textContent).toBe('(-15m30s)');
  });

  it('shows no offset under 5 s', () => {
    const msg: MeshCoreMessage = {
      id: 'close', fromPublicKey: 'channel-0', fromName: 'Close', text: 'hi',
      timestamp: SEC * 1000, senderTimestamp: SEC, receivedAt: RECEIPT + 4_900,
    };
    const { container } = render(
      <MeshCoreMessageStream messages={[msg]} selfPublicKey={SELF} onSend={async () => true} />,
    );
    const cell = timeCell(container, 'close');
    expect(cell.textContent).toContain(new Date(RECEIPT + 4_900).toLocaleTimeString());
    expect(cell.querySelector('[data-testid="mc-clock-offset"]')).toBeNull();
  });

  it('keeps sender time and shows no offset on a room post', () => {
    const msg: MeshCoreMessage = {
      id: 'room', fromPublicKey: 'cc'.repeat(6), toPublicKey: SELF, text: 'post', messageType: 'room_post',
      timestamp: (SEC - 930) * 1000, senderTimestamp: SEC - 930, receivedAt: RECEIPT,
    };
    const { container } = render(
      <MeshCoreMessageStream messages={[msg]} selfPublicKey={SELF} onSend={async () => true} />,
    );
    const cell = timeCell(container, 'room');
    expect(cell.textContent).toContain(new Date((SEC - 930) * 1000).toLocaleTimeString());
    expect(cell.querySelector('[data-testid="mc-clock-offset"]')).toBeNull();
  });
});
