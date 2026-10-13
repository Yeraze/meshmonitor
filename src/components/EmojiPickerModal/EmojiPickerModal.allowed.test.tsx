/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmojiPickerModal, DEFAULT_TAPBACK_EMOJIS } from './EmojiPickerModal';
import { isReactionEmoji } from '../../utils/meshcoreReactions';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

interface Row { id: string }
const row: Row = { id: 'r1' };

describe('EmojiPickerModal isEmojiAllowed', () => {
  it('drops grid entries that fail the filter', () => {
    render(
      <EmojiPickerModal<Row>
        message={row}
        onSelectEmoji={vi.fn()}
        onClose={vi.fn()}
        customEmojis={[{ emoji: '👍', title: 'Up' }, { emoji: '7', title: 'Digit' }]}
        isEmojiAllowed={isReactionEmoji}
      />,
    );
    expect(screen.queryByTitle('Up')).not.toBeNull();
    expect(screen.queryByTitle('Digit')).toBeNull();
  });

  it('shows every entry without a filter', () => {
    render(
      <EmojiPickerModal<Row>
        message={row}
        onSelectEmoji={vi.fn()}
        onClose={vi.fn()}
        customEmojis={[{ emoji: '👍', title: 'Up' }, { emoji: '7', title: 'Digit' }]}
      />,
    );
    expect(screen.queryByTitle('Digit')).not.toBeNull();
  });

  it('disables custom Send for a bare digit and enables it for an emoji', async () => {
    const onSelect = vi.fn();
    render(
      <EmojiPickerModal<Row> message={row} onSelectEmoji={onSelect} onClose={vi.fn()} isEmojiAllowed={isReactionEmoji} />,
    );
    await userEvent.click(screen.getByTitle('Custom emoji'));
    const input = screen.getByRole('textbox');
    const send = screen.getByTitle('Send') as HTMLButtonElement;
    await userEvent.type(input, '7');
    expect(send.disabled).toBe(true);
    await userEvent.type(input, '{Enter}');
    expect(onSelect).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, '🔥');
    expect(send.disabled).toBe(false);
  });

  it('passes the typed message through', async () => {
    const onSelect = vi.fn();
    render(<EmojiPickerModal<Row> message={row} onSelectEmoji={onSelect} onClose={vi.fn()} isEmojiAllowed={isReactionEmoji} />);
    await userEvent.click(screen.getByTitle('Thumbs up'));
    expect(onSelect).toHaveBeenCalledWith('👍', row);
  });

  it('every default tapback emoji passes isReactionEmoji', () => {
    const failing = DEFAULT_TAPBACK_EMOJIS.filter(e => !isReactionEmoji(e.emoji)).map(e => e.title);
    expect(failing).toEqual([]);
  });
});
