/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SenderAvatar, SenderNameButton, StatusEmojiIndicator } from './SenderAvatar';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

describe('SenderAvatar (#5645)', () => {
  it('draws the existing dot with the short name and no badge when there is no status', () => {
    const { container } = render(<SenderAvatar shortName="ABCD" onActivate={vi.fn()} />);
    const dot = container.querySelector('.sender-dot');
    expect(dot).not.toBeNull();
    expect(dot).toHaveClass('clickable');
    expect(dot).not.toHaveClass('is-emoji');
    expect(dot).toHaveTextContent('ABCD');
    expect(screen.queryByTestId('sender-avatar-status-badge')).toBeNull();
  });

  it('shows the leading emoji as a badge, labelled with the full status', () => {
    render(<SenderAvatar shortName="ABCD" status="📡 Monitoring 146.52 all day" onActivate={vi.fn()} />);
    const badge = screen.getByTestId('sender-avatar-status-badge');
    expect(badge).toHaveTextContent('📡');
    expect(badge.textContent).toBe('📡');
    expect(badge).toHaveAttribute('aria-label', 'Status: 📡 Monitoring 146.52 all day');
    expect(badge).toHaveAttribute('role', 'img');
  });

  it.each([
    ['letter first', 'Monitoring'],
    ['digit first', '1-800-NUMBER'],
    ['space first', ' 📡 late'],
    ['empty', ''],
  ])('shows no badge for a status that is %s', (_name, status) => {
    render(<SenderAvatar shortName="ABCD" status={status} onActivate={vi.fn()} />);
    expect(screen.queryByTestId('sender-avatar-status-badge')).toBeNull();
  });

  it('keeps a whole flag or ZWJ sequence as one badge', () => {
    const { rerender } = render(<SenderAvatar shortName="ABCD" status="🇺🇸 QRV" />);
    expect(screen.getByTestId('sender-avatar-status-badge').textContent).toBe('🇺🇸');
    rerender(<SenderAvatar shortName="ABCD" status="👨‍👩‍👧‍👦 Family trip" />);
    expect(screen.getByTestId('sender-avatar-status-badge').textContent).toBe('👨‍👩‍👧‍👦');
  });

  it('still shows the badge when the short name is itself an emoji', () => {
    const { container } = render(<SenderAvatar shortName="🦊" status="💤 asleep" onActivate={vi.fn()} />);
    expect(container.querySelector('.sender-dot')).toHaveClass('is-emoji');
    expect(screen.getByTestId('sender-avatar-status-badge').textContent).toBe('💤');
  });

  it('renders a status as text, never as markup', () => {
    const { container } = render(
      <SenderAvatar shortName="ABCD" status={'🆘<img src=x onerror=alert(1)><b>bold</b>'} onActivate={vi.fn()} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    const badge = screen.getByTestId('sender-avatar-status-badge');
    expect(badge.textContent).toBe('🆘');
    expect(badge.getAttribute('aria-label')).toContain('<img src=x onerror=alert(1)>');
  });

  it('gives an SOS or warning emoji the same neutral badge as any other', () => {
    const { rerender } = render(<SenderAvatar shortName="ABCD" status="📡 fine" />);
    const plainClass = screen.getByTestId('sender-avatar-status-badge').className;
    for (const status of ['🆘 help', '⚠️ storm', '🚨 alarm']) {
      rerender(<SenderAvatar shortName="ABCD" status={status} />);
      const badge = screen.getByTestId('sender-avatar-status-badge');
      expect(badge.className).toBe(plainClass);
      expect(badge).not.toHaveAttribute('role', 'alert');
      expect(badge).not.toHaveAttribute('style');
    }
  });

  it('lets a higher-priority badge take the corner slot from the status emoji', () => {
    render(<SenderAvatar shortName="ABCD" status="📡 Monitoring" cornerBadge={<span>V</span>} />);
    expect(screen.getByTestId('sender-avatar-corner-badge')).toHaveTextContent('V');
    expect(screen.queryByTestId('sender-avatar-status-badge')).toBeNull();
  });

  it('opens on click and on Enter or Space, and is reachable by Tab', () => {
    const onActivate = vi.fn();
    render(<SenderAvatar shortName="ABCD" title="Click for Alice details" onActivate={onActivate} />);
    const dot = screen.getByRole('button');
    expect(dot).toHaveAttribute('tabindex', '0');
    expect(dot).toHaveAttribute('data-node-popup-trigger');

    fireEvent.click(dot);
    fireEvent.keyDown(dot, { key: 'Enter' });
    fireEvent.keyDown(dot, { key: ' ' });
    fireEvent.keyDown(dot, { key: 'a' });
    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  it('is a plain dot, not a button, without a handler', () => {
    const { container } = render(<SenderAvatar shortName="ABCD" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('.sender-dot')).not.toHaveClass('clickable');
  });

  it('passes the per-node tint through', () => {
    const { container } = render(
      <SenderAvatar shortName="ABCD" style={{ background: 'var(--color-accent)' }} onActivate={vi.fn()} />,
    );
    expect((container.querySelector('.sender-dot') as HTMLElement).style.background).toBe('var(--color-accent)');
  });
});

describe('SenderNameButton (#5645)', () => {
  it('is a real button that keeps the sender-name class', () => {
    const onActivate = vi.fn();
    render(<SenderNameButton name="Alice Node" onActivate={onActivate} />);
    const button = screen.getByRole('button', { name: 'Alice Node' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveClass('sender-name');
    expect(button).toHaveAttribute('data-node-popup-trigger');
    fireEvent.click(button);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('drops the feed class in the header variant', () => {
    render(<SenderNameButton name="Alice Node" variant="header" onActivate={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Alice Node' })).not.toHaveClass('sender-name');
  });
});

describe('StatusEmojiIndicator (#5645)', () => {
  it('renders the leading emoji with the full status as its label', () => {
    render(<StatusEmojiIndicator status="🚗 Driving to the site" className="node-indicator-icon" />);
    const item = screen.getByTestId('status-emoji-indicator');
    expect(item.textContent).toBe('🚗');
    expect(item).toHaveClass('node-indicator-icon');
    expect(item).toHaveAttribute('aria-label', 'Status: 🚗 Driving to the site');
    expect(item).toHaveAttribute('title', 'Status: 🚗 Driving to the site');
  });

  it('renders nothing for a letter-first or missing status', () => {
    const { container, rerender } = render(<StatusEmojiIndicator status="Driving" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<StatusEmojiIndicator status={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
