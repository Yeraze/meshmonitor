/**
 * @vitest-environment jsdom
 *
 * "Clear stored posts & re-sync" control (#6579).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreRoomResync } from './MeshCoreRoomResync';

// Default-value `t`, so the tests read the English copy.
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const NOW = 1_763_000_000_000;
const now = () => NOW;

function setup(over: Partial<React.ComponentProps<typeof MeshCoreRoomResync>> = {}) {
  const onClear = vi.fn().mockResolvedValue({
    success: true, deleted: 7, resyncQueued: true, clearedAt: NOW, nextAllowedAt: NOW + 30 * 60_000,
  });
  const onCleared = vi.fn();
  render(
    <MeshCoreRoomResync
      roomName="Town Room"
      isCompanion
      connected
      lastClearAt={null}
      onClear={onClear}
      onCleared={onCleared}
      now={now}
      {...over}
    />,
  );
  return { onClear, onCleared };
}

const button = () => screen.getByRole('button', { name: /clear stored posts & re-sync/i });

describe('MeshCoreRoomResync', () => {
  it('is disabled with a one-line reason on a non-Companion (repeater-ingest) source', () => {
    const { onClear } = setup({ isCompanion: false });
    expect(button()).toBeDisabled();
    expect(screen.getByText(/only a companion radio keeps a room contact/i)).toBeInTheDocument();
    fireEvent.click(button());
    expect(onClear).not.toHaveBeenCalled();
  });

  it('asks first, and the dialog states the 32-post server cap', async () => {
    const { onClear, onCleared } = setup();
    fireEvent.click(button());
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/32 posts/);
    expect(dialog.textContent).toMatch(/only what the room server still holds/);
    expect(onClear).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /clear and re-sync/i }));
    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onCleared).toHaveBeenCalled());
    expect(await screen.findByText(/cleared 7 stored posts/i)).toBeInTheDocument();
    // The cooldown starts at once.
    expect(button()).toBeDisabled();
    expect(screen.getByText(/available again in 30 min/i)).toBeInTheDocument();
  });

  it('cancel does nothing', () => {
    const { onClear } = setup();
    fireEvent.click(button());
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onClear).not.toHaveBeenCalled();
  });

  it('shows the time left from a stored clear and stays disabled', () => {
    setup({ lastClearAt: NOW - 10 * 60_000 });
    expect(button()).toBeDisabled();
    expect(screen.getByText(/available again in 20 min/i)).toBeInTheDocument();
  });

  it('is enabled again once the cooldown has passed', () => {
    setup({ lastClearAt: NOW - 31 * 60_000 });
    expect(button()).not.toBeDisabled();
  });

  it('a 429 from the server shows the time left', async () => {
    const onClear = vi.fn().mockResolvedValue({ success: false, error: 'x', code: 'ROOM_CLEAR_COOLDOWN', retryAfterSeconds: 600 });
    setup({ onClear });
    fireEvent.click(button());
    fireEvent.click(screen.getByRole('button', { name: /clear and re-sync/i }));
    expect(await screen.findByText(/available again in 10 min/i)).toBeInTheDocument();
  });

  it('is disabled while the source is disconnected', () => {
    setup({ connected: false });
    expect(button()).toBeDisabled();
  });
});
