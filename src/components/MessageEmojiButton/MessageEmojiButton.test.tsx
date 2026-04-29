/**
 * Tests for MessageEmojiButton
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('MessageEmojiButton — popover behaviour', () => {
  beforeEach(() => {
    (useIsDesktop as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('opens picker on click', async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLTextAreaElement>();
    render(<MessageEmojiButton textareaRef={ref} value="" onChange={() => {}} />);

    expect(screen.queryByTestId('emoji-picker-mock')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'messages.insert_emoji_button_title' }));
    await waitFor(() => {
      expect(screen.getByTestId('emoji-picker-mock')).toBeInTheDocument();
    });
  });

  it('closes picker on Escape', async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLTextAreaElement>();
    render(<MessageEmojiButton textareaRef={ref} value="" onChange={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'messages.insert_emoji_button_title' }));
    await waitFor(() => screen.getByTestId('emoji-picker-mock'));

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('emoji-picker-mock')).not.toBeInTheDocument();
    });
  });

  it('closes picker on outside click', async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLTextAreaElement>();
    render(
      <div>
        <div data-testid="outside" />
        <MessageEmojiButton textareaRef={ref} value="" onChange={() => {}} />
      </div>
    );
    await user.click(screen.getByRole('button', { name: 'messages.insert_emoji_button_title' }));
    await waitFor(() => screen.getByTestId('emoji-picker-mock'));

    fireEvent.mouseDown(screen.getByTestId('outside'));

    await waitFor(() => {
      expect(screen.queryByTestId('emoji-picker-mock')).not.toBeInTheDocument();
    });
  });
});
