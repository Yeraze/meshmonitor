/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  const t = (key: string, fallback?: string | Record<string, unknown>) =>
    typeof fallback === 'string' ? fallback : key;
  return createReactI18nextMock(t);
});

import { MuteMenu, MutedIndicator } from './MuteMenu';
import { MUTE_DURATIONS } from './muteDurations';

const NOW = 1_700_000_000_000;

describe('MuteMenu', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('button variant opens a menu and mutes with each duration', async () => {
    const onMute = vi.fn();
    const onDone = vi.fn();
    render(<MuteMenu muted={false} onMute={onMute} onUnmute={vi.fn()} onDone={onDone} />);
    const bell = screen.getByRole('button', { name: 'Mute notifications' });
    expect(bell.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();

    const choose = async (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: 'Mute notifications' }));
      expect(screen.getByRole('menu')).toBeTruthy();
      await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name })); });
    };
    await choose('Mute indefinitely');
    expect(onMute).toHaveBeenLastCalledWith(null);
    await choose('Mute for 1 hour');
    expect(onMute).toHaveBeenLastCalledWith(NOW + MUTE_DURATIONS.hour);
    await choose('Mute for 1 week');
    expect(onMute).toHaveBeenLastCalledWith(NOW + MUTE_DURATIONS.week);
    expect(onDone).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('offers Unmute only while muted, first in the list', async () => {
    const onUnmute = vi.fn();
    const first = render(<MuteMenu muted={false} onMute={vi.fn()} onUnmute={onUnmute} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByRole('menuitem', { name: 'Unmute' })).toBeNull();
    first.unmount();

    render(<MuteMenu muted onMute={vi.fn()} onUnmute={onUnmute} />);
    fireEvent.click(screen.getByRole('button', { name: 'Muted — click to change' }));
    const items = screen.getAllByRole('menuitem');
    expect(items[0].textContent).toContain('Unmute');
    await act(async () => { fireEvent.click(items[0]); });
    expect(onUnmute).toHaveBeenCalledTimes(1);
  });

  it('items variant renders bare menuitems with the caller class and fires onDone', async () => {
    const onMute = vi.fn();
    const onDone = vi.fn();
    render(
      <MuteMenu variant="items" muted={false} onMute={onMute} onUnmute={vi.fn()} onDone={onDone} itemClassName="actions-menu-item" />,
    );
    expect(screen.queryByRole('menu')).toBeNull();
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.className === 'actions-menu-item')).toBe(true);
    await act(async () => { fireEvent.click(items[1]); });
    expect(onMute).toHaveBeenCalledWith(NOW + MUTE_DURATIONS.hour);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('MutedIndicator is labelled', () => {
    render(<MutedIndicator />);
    expect(screen.getByLabelText('Notifications muted')).toBeTruthy();
  });
});
