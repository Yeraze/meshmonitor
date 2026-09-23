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
