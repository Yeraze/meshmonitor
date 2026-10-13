/**
 * @vitest-environment jsdom
 *
 * Room-post author display (#5774): a corrupted or unknown author prefix reads
 * as an unknown sender and cannot be opened as a DM target; a clean prefix
 * resolves to the contact name.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import type { MeshCoreMessage } from './hooks/useMeshCore';

const SELF = 'a'.repeat(64);
const ROOM = '0102030405' + 'b'.repeat(54);
const ALICE = '6ab2c4d8' + 'c'.repeat(56);
const BOB = 'c54d319e' + 'd'.repeat(56);
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

function post(from: string, id: string): MeshCoreMessage {
  return {
    id, fromPublicKey: from, toPublicKey: ROOM, text: `text-${id}`, timestamp: T0,
    messageType: 'room_post',
  } as MeshCoreMessage;
}

function renderPosts(messages: MeshCoreMessage[], onNodeNameClick = vi.fn()) {
  render(
    <MeshCoreMessageStream
      messages={messages}
      selfPublicKey={SELF}
      onSend={async () => true}
      onNodeNameClick={onNodeNameClick}
      contacts={[
        { publicKey: ALICE, advName: 'Alice' },
        { publicKey: BOB, advName: 'Bob' },
      ] as any}
    />,
  );
  return onNodeNameClick;
}

describe('room post authors (#5774)', () => {
  it('resolves a clean prefix to the contact name and offers it as a target', () => {
    const click = renderPosts([post('6ab2c4d8', 'a')]);
    screen.getByText('Alice').click();
    expect(click).toHaveBeenCalledWith(ALICE);
  });

  it('reads a corrupted prefix as unknown when it cannot be matched uniquely', () => {
    const click = renderPosts([post('6afffdfffdfffd', 'a'), post('unknown', 'b')]);
    expect(screen.getAllByText('Unknown sender')).toHaveLength(2);
    expect(screen.queryByText('Alice')).toBeNull();
    expect(click).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('button', { name: 'Unknown sender' })).toHaveLength(0);
  });

  it('matches a corrupted prefix to the one contact that fits', () => {
    // c5 4d 31 9e -> fffd4d31fffd: two bytes survive, only Bob fits.
    renderPosts([post('fffd4d31fffd', 'a')]);
    expect(screen.getByText('Bob')).toBeTruthy();
  });
});
