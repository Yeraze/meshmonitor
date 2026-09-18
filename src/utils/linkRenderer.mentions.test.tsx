/**
 * @vitest-environment jsdom
 *
 * Mention chips in rendered messages (#5276).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { renderMessageWithLinks } from './linkRenderer';

const NAMES: Record<string, string> = {
  '!ffccee11': 'EOC Operator',
  '!00a1b2c3': 'Field Node East',
};

const options = {
  resolveNodeName: (id: string) => NAMES[id],
  selfNodeId: '!00a1b2c3',
};

describe('renderMessageWithLinks mentions (#5276)', () => {
  it('shows the node\'s current name in place of the token', () => {
    render(<div>{renderMessageWithLinks('ping @!ffccee11 please', options)}</div>);
    expect(screen.getByText('@EOC Operator')).toBeInTheDocument();
    expect(screen.queryByText(/@!ffccee11/)).not.toBeInTheDocument();
  });

  it('reads a token of either case, since Android emits uppercase', () => {
    render(<div>{renderMessageWithLinks('@!FFCCEE11 hi', options)}</div>);
    expect(screen.getByText('@EOC Operator')).toBeInTheDocument();
  });

  it('leaves an unknown node readable as its raw token', () => {
    render(<div>{renderMessageWithLinks('@!12345678 who?', options)}</div>);
    expect(screen.getByText('@!12345678')).toBeInTheDocument();
  });

  it('marks a mention of the local node', () => {
    const { container } = render(<div>{renderMessageWithLinks('@!00a1b2c3 you there?', options)}</div>);
    expect(container.querySelector('.message-mention-self')).not.toBeNull();
  });

  it('renders mentions and links in the same message', () => {
    render(<div>{renderMessageWithLinks('@!ffccee11 see https://example.com now', options)}</div>);
    expect(screen.getByText('@EOC Operator')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com');
  });

  it('opens the node when a chip is clicked, and on Enter', () => {
    const onMentionClick = vi.fn();
    render(<div>{renderMessageWithLinks('@!ffccee11', { ...options, onMentionClick })}</div>);

    const chip = screen.getByRole('button', { name: '@EOC Operator' });
    fireEvent.click(chip);
    fireEvent.keyDown(chip, { key: 'Enter' });
    expect(onMentionClick).toHaveBeenCalledTimes(2);
    expect(onMentionClick).toHaveBeenCalledWith('!ffccee11');
  });

  it('is not clickable without a handler', () => {
    render(<div>{renderMessageWithLinks('@!ffccee11', options)}</div>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('leaves text with no mentions untouched', () => {
    render(<div>{renderMessageWithLinks('plain message', options)}</div>);
    expect(screen.getByText('plain message')).toBeInTheDocument();
  });
});
