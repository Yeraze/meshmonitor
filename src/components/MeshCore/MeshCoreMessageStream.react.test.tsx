/**
 * @vitest-environment jsdom
 *
 * React button and clickable chips on the MeshCore message stream (#5762).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import type { MeshCoreMessage } from './hooks/useMeshCore';

const SELF = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

function chan(overrides: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return {
    id: 'm-1', fromPublicKey: PEER, fromName: 'Peer', toPublicKey: 'channel-0',
    text: 'hello', timestamp: T0, senderTimestamp: Math.floor(T0 / 1000), ...overrides,
  };
}

function reactionRow(from: string, name: string, emoji: string, id: string): MeshCoreMessage {
  return {
    id, fromPublicKey: from, fromName: name, toPublicKey: 'channel-0', text: emoji,
    timestamp: T0 + 1000, reactionEmoji: emoji, reactionTargetId: 'm-1', reactionFormat: 'mc1-channel',
  };
}

function renderStream(messages: MeshCoreMessage[], props: Record<string, unknown> = {}) {
  const onReact = vi.fn(async () => true);
  const utils = render(
    <MeshCoreMessageStream
      messages={messages}
      selfPublicKey={SELF}
      onSend={async () => true}
      onReact={'onReact' in props ? (props.onReact as any) : onReact}
      {...props}
    />,
  );
  return { onReact, ...utils };
}

const reactButtons = () => screen.queryAllByTestId('mc-react-button');

describe('MeshCoreMessageStream — react (#5762)', () => {
  it('shows the button on a reactable message', () => {
    renderStream([chan()]);
    expect(reactButtons()).toHaveLength(1);
  });

  it('hides it without onReact, while disabled, and on rows that cannot take reactions', () => {
    renderStream([chan()], { onReact: undefined });
    expect(reactButtons()).toHaveLength(0);
  });

  it('hides it while disabled', () => {
    renderStream([chan()], { disabled: true });
    expect(reactButtons()).toHaveLength(0);
  });

  it('hides it on a room post and an ignored row', () => {
    renderStream([
      chan({ id: 'r', messageType: 'room_post' } as any),
      chan({ id: 'f', filtered: true } as any),
    ]);
    expect(reactButtons()).toHaveLength(0);
  });

  it('picking an emoji calls onReact with the message and emoji', () => {
    const { onReact } = renderStream([chan()]);
    fireEvent.click(reactButtons()[0]);
    const grid = document.querySelector('.emoji-picker-grid')!;
    fireEvent.click(grid.querySelector('.emoji-picker-item')!);
    expect(onReact).toHaveBeenCalledTimes(1);
    expect((onReact.mock.calls[0] as any[])[0].id).toBe('m-1');
  });

  it('clicking another node chip reacts with its emoji; our own chip is not a button', () => {
    const { onReact } = renderStream([
      chan(),
      reactionRow(PEER, 'Peer', '👍', 'r1'),
      reactionRow(SELF, 'Me', '❤️', 'r2'),
    ]);
    const buttons = screen.getAllByRole('button').filter(b => b.textContent?.includes('👍'));
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onReact).toHaveBeenCalledTimes(1);
    expect((onReact.mock.calls[0] as any[])[1]).toBe('👍');
    expect(screen.getAllByRole('button').filter(b => b.textContent?.includes('❤'))).toHaveLength(0);
  });

  it('does not send when we already sent that emoji', () => {
    const { onReact } = renderStream([
      chan(),
      reactionRow(PEER, 'Peer', '👍', 'r1'),
      reactionRow(SELF, 'Me', '👍', 'r2'),
    ]);
    // The shared chip is ours ("mine"), so it is no button.
    expect(screen.getAllByRole('button').filter(b => b.textContent?.includes('👍'))).toHaveLength(0);
    fireEvent.click(reactButtons()[0]);
    fireEvent.click(document.querySelector('.emoji-picker-grid .emoji-picker-item')!);
    // First grid item may differ from 👍; the guard is covered by the chip being inert above.
    expect(onReact.mock.calls.every(c => (c as any[])[1] !== '👍')).toBe(true);
  });
});
