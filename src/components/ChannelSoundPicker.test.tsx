/**
 * @vitest-environment jsdom
 *
 * Component test for the per-channel notification sound picker. Verifies that:
 *   - a dropdown renders per channel
 *   - the DM pseudo-channel row appears for Meshtastic and is hidden for MeshCore
 *   - changing a channel's selection persists it (scoped per source)
 *   - the preview button plays the selected sound
 *   - choosing "Silent" disables the preview button
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import ChannelSoundPicker from './ChannelSoundPicker';
import { getChannelSoundId } from '../utils/notificationSounds';

const CHANNELS = [
  { id: 0, name: 'Primary' },
  { id: 1, name: 'Secondary' },
];

// Mutable source state so individual tests can switch source/sourceType.
const { sourceState } = vi.hoisted(() => ({
  sourceState: { current: { sourceId: null as string | null, sourceType: null as string | null } },
}));

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(async () => CHANNELS),
  },
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../contexts/SourceContext', () => ({
  useSource: () => sourceState.current,
}));

// Spy on playSound so we can assert preview triggers playback without real audio.
const playSoundMock = vi.fn(() => true);
vi.mock('../utils/notificationSounds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/notificationSounds')>();
  return {
    ...actual,
    playSound: (...args: Parameters<typeof actual.playSound>) => playSoundMock(...args),
  };
});

/** The preview button inside the row that owns the given select element. */
function previewButtonFor(select: HTMLSelectElement): HTMLButtonElement {
  const row = select.closest('.setting-item') as HTMLElement;
  return within(row).getByRole('button') as HTMLButtonElement;
}

describe('ChannelSoundPicker', () => {
  beforeEach(() => {
    localStorage.clear();
    playSoundMock.mockClear();
    sourceState.current = { sourceId: null, sourceType: null };
  });

  it('renders a sound dropdown for each channel', async () => {
    render(<ChannelSoundPicker />);
    await waitFor(() => {
      expect(screen.getByLabelText('Primary')).toBeInTheDocument();
      expect(screen.getByLabelText('Secondary')).toBeInTheDocument();
    });
  });

  it('shows the DM pseudo-channel row for a Meshtastic source', async () => {
    render(<ChannelSoundPicker />);
    // The i18n mock returns the key, so the DM row is labelled by its key.
    expect(await screen.findByLabelText('settings.channel_sound_dm')).toBeInTheDocument();
  });

  it('hides the DM row for a MeshCore source', async () => {
    sourceState.current = { sourceId: 'mc1', sourceType: 'meshcore' };
    render(<ChannelSoundPicker />);
    await screen.findByLabelText('Primary');
    expect(screen.queryByLabelText('settings.channel_sound_dm')).not.toBeInTheDocument();
  });

  it('persists a channel selection independently per channel', async () => {
    render(<ChannelSoundPicker />);
    const primary = (await screen.findByLabelText('Primary')) as HTMLSelectElement;

    fireEvent.change(primary, { target: { value: 'coin' } });

    expect(getChannelSoundId(0)).toBe('coin');
    // The other channel is unaffected and still defaults.
    expect(getChannelSoundId(1)).toBe('classic-ding');
    expect(primary.value).toBe('coin');
  });

  it('scopes a selection to the active source', async () => {
    sourceState.current = { sourceId: 'srcA', sourceType: null };
    render(<ChannelSoundPicker />);
    const primary = (await screen.findByLabelText('Primary')) as HTMLSelectElement;

    fireEvent.change(primary, { target: { value: 'coin' } });

    expect(getChannelSoundId(0, 'srcA')).toBe('coin');
    // A different source is unaffected.
    expect(getChannelSoundId(0, 'srcB')).toBe('classic-ding');
  });

  it('persists a sound for the DM pseudo-channel', async () => {
    render(<ChannelSoundPicker />);
    const dm = (await screen.findByLabelText('settings.channel_sound_dm')) as HTMLSelectElement;

    fireEvent.change(dm, { target: { value: 'ping' } });

    expect(getChannelSoundId(-1)).toBe('ping');
  });

  it('plays the selected sound when preview is clicked', async () => {
    render(<ChannelSoundPicker />);
    const primary = (await screen.findByLabelText('Primary')) as HTMLSelectElement;
    fireEvent.change(primary, { target: { value: 'boop' } });

    fireEvent.click(previewButtonFor(primary));

    expect(playSoundMock).toHaveBeenCalledWith('boop');
  });

  it('disables preview when a channel is set to Silent', async () => {
    render(<ChannelSoundPicker />);
    const primary = (await screen.findByLabelText('Primary')) as HTMLSelectElement;
    fireEvent.change(primary, { target: { value: 'none' } });

    expect(previewButtonFor(primary)).toBeDisabled();
  });

  it('seeds the dropdown from a previously stored selection', async () => {
    localStorage.setItem('channelNotificationSound:1', 'arpeggio');
    render(<ChannelSoundPicker />);
    const secondary = (await screen.findByLabelText('Secondary')) as HTMLSelectElement;
    expect(secondary.value).toBe('arpeggio');
  });
});
