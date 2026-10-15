/**
 * @vitest-environment jsdom
 *
 * Issue #5324: two defects on the Channels config screen.
 *
 * 1. Delete called `DELETE /api/channels/:id` without a sourceId. The route
 *    requires one, so it answered 400, the client swallowed that as
 *    "best-effort", and the channel row and its messages were never removed.
 * 2. The sortable cards registered string ids while SortableContext held
 *    numeric slot indices. dnd-kit finds items with `indexOf`, so every card sat
 *    at index -1 and nothing shifted while dragging — the drop still worked, but
 *    the drag looked broken.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { UniqueIdentifier } from '@dnd-kit/core';
import ChannelsConfigSection from './ChannelsConfigSection';
import apiService from '../../services/api';
import type { Channel } from '../../types/device';

const sortable = vi.hoisted(() => ({
  contextItems: [] as UniqueIdentifier[][],
  cardIds: [] as UniqueIdentifier[],
}));

vi.mock('@dnd-kit/sortable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/sortable')>();
  return {
    ...actual,
    SortableContext: (props: Parameters<typeof actual.SortableContext>[0]) => {
      sortable.contextItems.push(props.items as UniqueIdentifier[]);
      return actual.SortableContext(props);
    },
    useSortable: (args: Parameters<typeof actual.useSortable>[0]) => {
      sortable.cardIds.push(args.id);
      return actual.useSortable(args);
    },
  };
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ settings: {}, updateSetting: vi.fn() }),
}));

vi.mock('../../hooks/useResolvedSourceId', () => ({
  useResolvedSourceId: () => 'src-1',
}));

const channels = [
  { id: 0, name: 'Primary', psk: 'AQ==', role: 1, uplinkEnabled: false, downlinkEnabled: false },
  { id: 4, name: 'Four', psk: 'AQ==', role: 2, uplinkEnabled: false, downlinkEnabled: false },
] as Channel[];

const renderSection = () =>
  render(
    <MemoryRouter>
      <ChannelsConfigSection channels={channels} />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
  sortable.contextItems.length = 0;
  sortable.cardIds.length = 0;
  vi.spyOn(apiService, 'get').mockResolvedValue([] as never);
});

describe('ChannelsConfigSection delete (#5324)', () => {
  it('sends the sourceId with the database delete', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(apiService, 'updateChannel').mockResolvedValue({} as never);
    const del = vi.spyOn(apiService, 'delete').mockResolvedValue({} as never);

    renderSection();
    // The sortable card wrapper is itself role="button", so match the real <button>.
    const deleteButton = screen
      .getAllByRole('button', { name: /delete/i })
      .find(el => el.tagName === 'BUTTON');
    fireEvent.click(deleteButton!);

    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/channels/4?sourceId=src-1'));
  });
});

describe('ChannelsConfigSection PSK clearing (#5826)', () => {
  const KEY = 'BwcHBwcHBwcHBwcHBwcHBw==';

  // Card order is slot order, so the n-th Edit button edits slot n.
  const editSlot = (slot: number, list: Channel[]) => {
    render(
      <MemoryRouter>
        <ChannelsConfigSection channels={list} />
      </MemoryRouter>,
    );
    const edits = screen.getAllByRole('button', { name: /common\.edit/ }).filter(el => el.tagName === 'BUTTON');
    fireEvent.click(edits[slot]);
    return screen.getByLabelText(/channels_config\.psk/, { selector: 'input' }) as HTMLInputElement;
  };
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'channels_config.save_channel' }));

  it('sends an explicit empty psk when the user clears a key', async () => {
    const update = vi.spyOn(apiService, 'updateChannel').mockResolvedValue({} as never);
    const input = editSlot(2, [{ id: 2, name: 'Secret', psk: KEY, role: 2 } as Channel]);
    expect(input.value).toBe(KEY);
    fireEvent.change(input, { target: { value: '' } });
    save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1]).toHaveProperty('psk', '');
  });

  it('leaves psk out when the field opened empty and stayed empty', async () => {
    const update = vi.spyOn(apiService, 'updateChannel').mockResolvedValue({} as never);
    // A reader without write access never receives the key.
    editSlot(2, [{ id: 2, name: 'Secret', role: 2 } as Channel]);
    save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1].psk).toBeUndefined();
  });

  it('shows the AA== "encryption off" key as an empty field and keeps it on save', async () => {
    const update = vi.spyOn(apiService, 'updateChannel').mockResolvedValue({} as never);
    const input = editSlot(2, [{ id: 2, name: 'Open', psk: 'AA==', role: 2 } as Channel]);
    expect(input.value).toBe('');
    save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1].psk).toBeUndefined();
  });

  it('sends an unchanged key as is', async () => {
    const update = vi.spyOn(apiService, 'updateChannel').mockResolvedValue({} as never);
    editSlot(2, [{ id: 2, name: 'Secret', psk: KEY, role: 2 } as Channel]);
    save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1].psk).toBe(KEY);
  });
});

describe('ChannelsConfigSection drag ids (#5324)', () => {
  it('registers every card under an id SortableContext can find', () => {
    renderSection();

    const items = sortable.contextItems.at(-1)!;
    expect(sortable.cardIds.length).toBeGreaterThan(0);
    // indexOf is exactly what dnd-kit uses; a type mismatch returns -1.
    for (const id of sortable.cardIds) {
      expect(items.indexOf(id)).toBeGreaterThanOrEqual(0);
    }
  });
});
