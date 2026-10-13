/**
 * @vitest-environment jsdom
 *
 * MeshCoreMessageStream reactions (#5759): a reaction row draws no bubble. It
 * is a chip under its target, or one dim line while the target is unknown.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import type { MeshCoreMessage } from './hooks/useMeshCore';

function msg(id: string, extra: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return { id, fromPublicKey: 'channel-1', fromName: 'Alice', text: 'hello there', timestamp: 1_700_000_000_000, ...extra };
}
function reaction(id: string, emoji: string, target: string | null, extra: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return msg(id, {
    fromName: 'Bob',
    text: emoji,
    reactionEmoji: emoji,
    reactionTargetId: target,
    reactionRawText: `@[Alice]${emoji}\nb45pc4ek`,
    timestamp: 1_700_000_001_000,
    ...extra,
  });
}
const send = async () => true;

describe('MeshCoreMessageStream reactions', () => {
  it('shows a chip under the target with a count and the reactor names', () => {
    const { container } = render(
      <MeshCoreMessageStream
        messages={[msg('m1'), reaction('r1', '👍', 'm1'), reaction('r2', '👍', 'm1', { fromName: 'Carol' })]}
        onSend={send}
      />,
    );
    const chip = screen.getByTestId('mc-reaction-chip');
    expect(chip).toHaveTextContent('👍');
    expect(chip).toHaveTextContent('2');
    expect(chip).toHaveAttribute('title', '👍 Bob, Carol');
    // The chip sits inside the target's row, and no reaction has a bubble.
    expect(chip.closest('[data-message-id]')).toHaveAttribute('data-message-id', 'm1');
    expect(container.querySelectorAll('.mc-message-row')).toHaveLength(1);
    expect(screen.queryByTestId('mc-reaction-unmatched')).toBeNull();
  });

  it('shows one dim line, with the raw text as tooltip, for an unmatched reaction', () => {
    const onDelete = vi.fn();
    const { container } = render(
      <MeshCoreMessageStream messages={[msg('m1'), reaction('r1', '👍', null)]} onSend={send} onDeleteMessage={onDelete} />,
    );
    const line = screen.getByTestId('mc-reaction-unmatched');
    expect(line).toHaveTextContent('Bob reacted 👍 to a message not seen here');
    expect(line.getAttribute('title')).toContain('@[Alice]👍');
    expect(screen.queryByTestId('mc-reaction-chip')).toBeNull();
    // No bubble and no row actions for the line.
    expect(container.querySelectorAll('.mc-message-row')).toHaveLength(1);
    expect(container.querySelectorAll('.mc-message-delete')).toHaveLength(1);
  });

  it('turns the dim line into a chip when the reaction resolves', () => {
    const messages = [msg('m1'), reaction('r1', '👍', null)];
    const { rerender } = render(<MeshCoreMessageStream messages={messages} onSend={send} />);
    expect(screen.getByTestId('mc-reaction-unmatched')).toBeInTheDocument();

    rerender(<MeshCoreMessageStream messages={messages} reactionResolutions={{ r1: 'm1' }} onSend={send} />);
    expect(screen.queryByTestId('mc-reaction-unmatched')).toBeNull();
    expect(screen.getByTestId('mc-reaction-chip')).toHaveTextContent('👍');
  });

  it('shows the empty state when the only rows are hidden reactions', () => {
    render(<MeshCoreMessageStream messages={[reaction('r1', '👍', 'gone')]} emptyText="Nothing here" onSend={send} />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('never puts the unread divider on a dim line', () => {
    const { container } = render(
      <MeshCoreMessageStream
        messages={[
          msg('m1', { timestamp: 1_700_000_000_000 }),
          reaction('r1', '👍', null, { timestamp: 1_700_000_005_000 }),
          msg('m2', { timestamp: 1_700_000_009_000 }),
        ]}
        unreadAnchorMs={1_700_000_001_000}
        onSend={send}
      />,
    );
    const divider = container.querySelector('[data-unread-divider]');
    expect(divider).not.toBeNull();
    // The line is the first row after the watermark, but the divider skips it.
    expect(divider?.nextElementSibling).toHaveAttribute('data-message-id', 'm2');
  });
});
