/**
 * Tests for MessageEmojiButton
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useRef } from 'react';
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

describe('MessageEmojiButton — insertion', () => {
  beforeEach(() => {
    (useIsDesktop as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('inserts emoji at end when textarea ref is null', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const ref = createRef<HTMLTextAreaElement>();
    render(
      <MessageEmojiButton textareaRef={ref} value="hello" onChange={onChange} />
    );
    await user.click(screen.getByRole('button', { name: 'messages.insert_emoji_button_title' }));
    await user.click(await screen.findByTestId('mock-emoji-thumbs-up'));
    expect(onChange).toHaveBeenCalledWith('hello👍');
  });

  it('inserts emoji at the cursor position', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const Wrapper = () => {
      const ref = useRef<HTMLTextAreaElement>(null);
      return (
        <>
          <textarea ref={ref} defaultValue="hello world" data-testid="ta" />
          <MessageEmojiButton textareaRef={ref} value="hello world" onChange={onChange} />
        </>
      );
    };
    render(<Wrapper />);

    const ta = screen.getByTestId('ta') as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(5, 5); // cursor between "hello" and " world"

    await user.click(screen.getByRole('button', { name: 'messages.insert_emoji_button_title' }));
    await user.click(await screen.findByTestId('mock-emoji-thumbs-up'));

    expect(onChange).toHaveBeenCalledWith('hello👍 world');
  });

  it('replaces selected range with emoji', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const Wrapper = () => {
      const ref = useRef<HTMLTextAreaElement>(null);
      return (
        <>
          <textarea ref={ref} defaultValue="hello WORLD" data-testid="ta" />
          <MessageEmojiButton textareaRef={ref} value="hello WORLD" onChange={onChange} />
        </>
      );
    };
    render(<Wrapper />);

    const ta = screen.getByTestId('ta') as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(6, 11); // select "WORLD"

    await user.click(screen.getByRole('button', { name: 'messages.insert_emoji_button_title' }));
    await user.click(await screen.findByTestId('mock-emoji-thumbs-up'));

    expect(onChange).toHaveBeenCalledWith('hello 👍');
  });

  it('closes picker after selection', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const ref = createRef<HTMLTextAreaElement>();
    render(<MessageEmojiButton textareaRef={ref} value="" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'messages.insert_emoji_button_title' }));
    await user.click(await screen.findByTestId('mock-emoji-thumbs-up'));
    await waitFor(() => {
      expect(screen.queryByTestId('emoji-picker-mock')).not.toBeInTheDocument();
    });
  });
});

describe('MessageEmojiButton — theme detection', () => {
  beforeEach(() => {
    (useIsDesktop as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  it('renders without crashing for dark themes', async () => {
    document.documentElement.setAttribute('data-theme', 'mocha');
    const user = userEvent.setup();
    const ref = createRef<HTMLTextAreaElement>();
    render(<MessageEmojiButton textareaRef={ref} value="" onChange={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'messages.insert_emoji_button_title' }));
    expect(await screen.findByTestId('emoji-picker-mock')).toBeInTheDocument();
  });

  it('renders without crashing for light themes', async () => {
    document.documentElement.setAttribute('data-theme', 'latte');
    const user = userEvent.setup();
    const ref = createRef<HTMLTextAreaElement>();
    render(<MessageEmojiButton textareaRef={ref} value="" onChange={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'messages.insert_emoji_button_title' }));
    expect(await screen.findByTestId('emoji-picker-mock')).toBeInTheDocument();
  });
});
