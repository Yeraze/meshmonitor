/**
 * @vitest-environment jsdom
 *
 * ChannelsConfigSection (Meshtastic channel slots).
 *
 * #5324: Delete sent no sourceId, and the sortable cards registered ids that
 * SortableContext could not find. #5826: clearing a key sends ''. #5829: the
 * list is cards that open in place, with one "Save to device" per channel.
 *
 * The global i18n mock returns keys, so buttons are named by their key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { UniqueIdentifier } from '@dnd-kit/core';
import ChannelsConfigSection from './ChannelsConfigSection';
import apiService from '../../services/api';
import type { Channel } from '../../types/device';

const sortable = vi.hoisted(() => ({
  contextItems: [] as UniqueIdentifier[][],
  cardIds: [] as UniqueIdentifier[],
}));

const auth = vi.hoisted(() => ({ canWrite: true, calls: [] as unknown[][] }));

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
  useAuth: () => ({
    hasPermission: (...args: unknown[]) => {
      auth.calls.push(args);
      return auth.canWrite;
    },
  }),
}));

const toast = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: (...args: unknown[]) => { toast.calls.push(args); } }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ settings: {}, updateSetting: vi.fn() }),
}));

vi.mock('../../hooks/useResolvedSourceId', () => ({
  useResolvedSourceId: () => 'src-1',
}));

const KEY = 'BwcHBwcHBwcHBwcHBwcHBw==';

const channels = [
  { id: 0, name: 'Primary', psk: 'AQ==', role: 1, uplinkEnabled: false, downlinkEnabled: false },
  { id: 4, name: 'Four', psk: KEY, role: 2, uplinkEnabled: true, downlinkEnabled: false, positionPrecision: 13 },
  { id: 5, name: 'Off', psk: '', role: 0 },
] as Channel[];

const renderSection = (list: Channel[] = channels) =>
  render(
    <MemoryRouter>
      <ChannelsConfigSection channels={list} />
    </MemoryRouter>,
  );

// The sortable wrapper is itself role="button", so match real <button>s only.
const buttons = (name: string | RegExp) =>
  screen.getAllByRole('button', { name }).filter(el => el.tagName === 'BUTTON') as HTMLButtonElement[];
const cards = () => screen.getAllByTestId('channel-card');
const cardFor = (name: string) => cards().find(c => c.textContent?.includes(name))!;
const editCard = (name: string) =>
  fireEvent.click(within(cardFor(name)).getByRole('button', { name: 'common.edit' }));
const pskInput = () => screen.getByLabelText(/channels_config\.psk/, { selector: 'input' }) as HTMLInputElement;
const saveButton = () => buttons('channels_config.save_to_device')[0];

beforeEach(() => {
  vi.restoreAllMocks();
  auth.canWrite = true;
  auth.calls.length = 0;
  toast.calls.length = 0;
  sortable.contextItems.length = 0;
  sortable.cardIds.length = 0;
  vi.spyOn(apiService, 'get').mockResolvedValue([] as never);
});

describe('ChannelsConfigSection list (#5829)', () => {
  it('lists configured channels only, with slot numbers, and writes nothing on mount', () => {
    const update = vi.spyOn(apiService, 'updateChannel');
    const reorder = vi.spyOn(apiService, 'reorderDeviceChannels');
    renderSection();

    expect(cards()).toHaveLength(2);
    expect(cards()[0].textContent).toContain('Primary');
    expect(cards()[1].textContent).toContain('Four');
    expect(screen.queryByText('Off')).toBeNull();
    expect(cards()[0].textContent).toContain('channels_config.slot');
    expect(update).not.toHaveBeenCalled();
    expect(reorder).not.toHaveBeenCalled();
  });

  it('shows encryption, role and bridge chips on the collapsed card', () => {
    renderSection();
    const four = cardFor('Four');
    expect(four.textContent).toContain('channel_card.encryption_secure');
    expect(four.textContent).toContain('channels_config.role_secondary');
    expect(four.textContent).toContain('channels_config.uplink');
    expect(four.textContent).not.toContain('channels_config.downlink');
    expect(cardFor('Primary').textContent).toContain('channel_card.encryption_default');
    expect(cardFor('Primary').textContent).toContain('channels_config.primary');
  });

  it('gates the section on configuration:write for this source', () => {
    auth.canWrite = false;
    renderSection();
    expect(auth.calls).toContainEqual(['configuration', 'write', { sourceId: 'src-1' }]);
    for (const b of buttons('common.edit')) expect(b.disabled).toBe(true);
    expect((screen.getByTestId('channel-add') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ChannelsConfigSection add (#5829)', () => {
  it('opens a new card on the next free slot and saves it with one write', async () => {
    const update = vi.spyOn(apiService, 'updateChannel').mockResolvedValue({} as never);
    renderSection();

    fireEvent.click(screen.getByTestId('channel-add'));
    const card = screen.getByTestId('channel-card-new');
    // Slots 0 and 4 are used, so slot 1 is next.
    expect(card.textContent).toContain('channels_config.new_channel');
    expect((screen.getByLabelText(/channels_config\.channel_name/, { selector: 'input' }) as HTMLInputElement).value).toBe('Channel 1');
    // A fresh 32-byte key, not the disabled slot's old one.
    const key = pskInput().value;
    expect(atob(key)).toHaveLength(32);

    fireEvent.click(saveButton());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toBe(1);
    expect(update.mock.calls[0][1]).toMatchObject({ name: 'Channel 1', role: 2, psk: key });
    expect(update.mock.calls[0][2]).toBe('src-1');
  });

  it('treats a DISABLED slot as free', () => {
    const list = [0, 1, 2, 3, 4, 6, 7].map(id => ({ id, name: `C${id}`, role: id === 0 ? 1 : 2 } as Channel));
    list.push({ id: 5, name: '', role: 0 } as Channel);
    renderSection(list);
    fireEvent.click(screen.getByTestId('channel-add'));
    expect(screen.getByTestId('channel-card-new').textContent).toContain('channels_config.slot');
    expect((screen.getByLabelText(/channels_config\.channel_name/, { selector: 'input' }) as HTMLInputElement).value).toBe('Channel 5');
  });

  it('disables Add with a reason when all eight slots are in use', () => {
    const full = [0, 1, 2, 3, 4, 5, 6, 7].map(id => ({ id, name: `C${id}`, role: id === 0 ? 1 : 2 } as Channel));
    renderSection(full);
    const add = screen.getByTestId('channel-add') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.title).toBe('channels_config.add_channel_full');
    expect(screen.getByText('channels_config.add_channel_full')).toBeTruthy();
  });
});

describe('ChannelsConfigSection edit (#5829)', () => {
  it('Save to device is off until something changes, then sends exactly one write', async () => {
    const update = vi.spyOn(apiService, 'updateChannel').mockResolvedValue({} as never);
    renderSection();
    editCard('Four');
    expect(saveButton().disabled).toBe(true);

    const name = screen.getByLabelText(/channels_config\.channel_name/, { selector: 'input' });
    fireEvent.change(name, { target: { value: 'Fourth' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(4, {
      name: 'Fourth',
      psk: KEY,
      role: 2,
      uplinkEnabled: true,
      downlinkEnabled: false,
      positionPrecision: 13,
    }, 'src-1');
  });

  it('Cancel drops the draft and writes nothing', () => {
    const update = vi.spyOn(apiService, 'updateChannel');
    renderSection();
    editCard('Four');
    fireEvent.change(screen.getByLabelText(/channels_config\.channel_name/, { selector: 'input' }), { target: { value: 'Changed' } });
    fireEvent.click(buttons('common.cancel')[0]);
    expect(screen.queryByLabelText(/channels_config\.channel_name/, { selector: 'input' })).toBeNull();

    editCard('Four');
    expect((screen.getByLabelText(/channels_config\.channel_name/, { selector: 'input' }) as HTMLInputElement).value).toBe('Four');
    expect(update).not.toHaveBeenCalled();
  });

  it('blocks Save on a key of the wrong length', () => {
    renderSection();
    editCard('Four');
    fireEvent.change(pskInput(), { target: { value: 'AAAA' } }); // 3 bytes
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('channels_config.psk_invalid');
  });

  it('asks before opening another card over unsaved edits', () => {
    renderSection();
    editCard('Four');
    fireEvent.change(screen.getByLabelText(/channels_config\.channel_name/, { selector: 'input' }), { target: { value: 'Changed' } });
    editCard('Primary');
    expect(screen.getByRole('dialog').textContent).toContain('config_item_card.discard_title');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'config_item_card.discard_confirm' }));
    expect((screen.getByLabelText(/channels_config\.channel_name/, { selector: 'input' }) as HTMLInputElement).value).toBe('Primary');
  });
});

describe('ChannelsConfigSection delete (#5324, #5829)', () => {
  it('confirms that message history is purged, then sends the sourceId with the database delete', async () => {
    vi.spyOn(apiService, 'updateChannel').mockResolvedValue({} as never);
    const del = vi.spyOn(apiService, 'delete').mockResolvedValue({} as never);
    renderSection();

    // Slot 0 has no Delete.
    expect(within(cardFor('Primary')).queryByRole('button', { name: 'common.delete' })).toBeNull();
    fireEvent.click(within(cardFor('Four')).getByRole('button', { name: 'common.delete' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('channels_config.delete_message');
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'channels_config.delete_confirm' }));

    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/channels/4?sourceId=src-1'));
    await waitFor(() => expect(toast.calls).toContainEqual(['channels_config.toast_channel_deleted', 'success']));
  });

  it('warns, without claiming a delete, when the message purge fails after the device write', async () => {
    vi.spyOn(apiService, 'updateChannel').mockResolvedValue({} as never);
    vi.spyOn(apiService, 'delete').mockRejectedValue(new Error('boom'));
    renderSection();

    fireEvent.click(within(cardFor('Four')).getByRole('button', { name: 'common.delete' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'channels_config.delete_confirm' }));

    await waitFor(() => expect(toast.calls).toContainEqual(['channels_config.toast_channel_disabled_purge_failed', 'warning']));
    expect(toast.calls.some(c => c[0] === 'channels_config.toast_channel_deleted')).toBe(false);
  });
});

describe('ChannelsConfigSection role options (#5829 review)', () => {
  const roleValues = () =>
    Array.from((screen.getByLabelText(/channels_config\.channel_role/, { selector: 'select' }) as HTMLSelectElement).options)
      .map(o => Number(o.value));

  it('a new card on a non-zero slot offers Secondary only', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('channel-add'));
    expect(roleValues()).toEqual([2]);
  });

  it('a new card on slot 0 offers Primary only', () => {
    renderSection([{ id: 3, name: 'Three', role: 2 } as Channel]);
    fireEvent.click(screen.getByTestId('channel-add'));
    expect(roleValues()).toEqual([1]);
  });

  it('an existing secondary cannot become a second primary', () => {
    renderSection();
    editCard('Four');
    expect(roleValues()).toEqual([0, 2]);
  });

  it('an existing secondary may become primary when no channel is primary', () => {
    renderSection([{ id: 4, name: 'Four', psk: KEY, role: 2 } as Channel]);
    editCard('Four');
    expect(roleValues()).toEqual([0, 1, 2]);
  });

  it('the primary keeps all three choices', () => {
    renderSection();
    editCard('Primary');
    expect(roleValues()).toEqual([0, 1, 2]);
  });
});

describe('ChannelsConfigSection PSK clearing (#5826)', () => {
  const editOnly = (list: Channel[]) => {
    renderSection(list);
    fireEvent.click(buttons('common.edit')[0]);
    return pskInput();
  };
  const nameInput = () => screen.getByLabelText(/channels_config\.channel_name/, { selector: 'input' });
  const touchName = () => fireEvent.change(nameInput(), { target: { value: 'Renamed' } });

  it('sends an explicit empty psk when the user clears a key', async () => {
    const update = vi.spyOn(apiService, 'updateChannel').mockResolvedValue({} as never);
    const input = editOnly([{ id: 2, name: 'Secret', psk: KEY, role: 2 } as Channel]);
    expect(input.value).toBe(KEY);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1]).toHaveProperty('psk', '');
  });

  it('leaves psk out when the field opened empty and stayed empty', async () => {
    const update = vi.spyOn(apiService, 'updateChannel').mockResolvedValue({} as never);
    // A reader without write access never receives the key.
    editOnly([{ id: 2, name: 'Secret', role: 2 } as Channel]);
    touchName();
    fireEvent.click(saveButton());
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1].psk).toBeUndefined();
  });

  it('shows the AA== "encryption off" key as an empty field and keeps it on save', async () => {
    const update = vi.spyOn(apiService, 'updateChannel').mockResolvedValue({} as never);
    const input = editOnly([{ id: 2, name: 'Open', psk: 'AA==', role: 2 } as Channel]);
    expect(input.value).toBe('');
    touchName();
    fireEvent.click(saveButton());
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1].psk).toBeUndefined();
  });

  it('sends an unchanged key as is', async () => {
    const update = vi.spyOn(apiService, 'updateChannel').mockResolvedValue({} as never);
    editOnly([{ id: 2, name: 'Secret', psk: KEY, role: 2 } as Channel]);
    touchName();
    fireEvent.click(saveButton());
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

describe('ChannelsConfigSection AEAD (#5248 Phase 2b)', () => {
  const renderAead = (aeadSupported: boolean, list: Channel[] = channels) =>
    render(
      <MemoryRouter>
        <ChannelsConfigSection channels={list} aeadSupported={aeadSupported} />
      </MemoryRouter>,
    );
  const aeadBox = () => screen.getByTestId('channel-use-aead') as HTMLInputElement;

  it('asks before turning AEAD on, then saves it', async () => {
    const update = vi.spyOn(apiService, 'updateChannel').mockResolvedValue({} as never);
    renderAead(true);
    editCard('Four');

    fireEvent.click(aeadBox());
    expect(aeadBox().checked).toBe(false);
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('channels_config.aead_warning_title');
    fireEvent.click(within(dialog).getByRole('button', { name: 'channels_config.aead_confirm' }));
    expect(aeadBox().checked).toBe(true);

    fireEvent.click(saveButton());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).toMatchObject({ useAead: true });
  });

  it('cancelling the dialog leaves AEAD off and the card unchanged', () => {
    renderAead(true);
    editCard('Four');
    fireEvent.click(aeadBox());
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'common.cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(aeadBox().checked).toBe(false);
    expect(saveButton().disabled).toBe(true);
  });

  it('cannot be turned on before firmware 2.8.1', () => {
    renderAead(false);
    editCard('Four');
    expect(aeadBox().disabled).toBe(true);
    expect(screen.getByText('channels_config.aead_needs_firmware')).toBeTruthy();
  });

  it('can always be turned off, without a dialog', async () => {
    const update = vi.spyOn(apiService, 'updateChannel').mockResolvedValue({} as never);
    const list = channels.map(c => (c.id === 4 ? { ...c, useAead: true } : c)) as Channel[];
    renderAead(false, list);
    editCard('Four');
    expect(aeadBox().disabled).toBe(false);
    fireEvent.click(aeadBox());
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).toMatchObject({ useAead: false });
  });

  it('cannot be turned on without a key', () => {
    renderAead(true);
    editCard('Four');
    fireEvent.change(pskInput(), { target: { value: '' } });
    expect(aeadBox().disabled).toBe(true);
    expect(screen.getByText('channels_config.aead_needs_key')).toBeTruthy();
  });
});
