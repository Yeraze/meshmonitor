/**
 * Tests for MessageEmojiButton
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { MessageEmojiButton } from './MessageEmojiButton';

vi.mock('../../hooks/useIsDesktop', () => ({
  useIsDesktop: vi.fn(),
}));

import { useIsDesktop } from '../../hooks/useIsDesktop';

describe('MessageEmojiButton — visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the button on desktop', () => {
    (useIsDesktop as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const ref = createRef<HTMLTextAreaElement>();
    render(
      <MessageEmojiButton textareaRef={ref} value="" onChange={() => {}} />
    );
    expect(
      screen.getByRole('button', { name: 'messages.insert_emoji_button_title' })
    ).toBeInTheDocument();
  });

  it('renders nothing on touch devices', () => {
    (useIsDesktop as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const ref = createRef<HTMLTextAreaElement>();
    const { container } = render(
      <MessageEmojiButton textareaRef={ref} value="" onChange={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
