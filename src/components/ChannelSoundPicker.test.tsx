/**
 * @vitest-environment jsdom
 *
 * Component test for the per-channel notification sound picker. Verifies that:
 *   - a dropdown renders per channel
 *   - changing a channel's selection persists it (and round-trips on reload)
 *   - the preview button plays the selected sound
 *   - choosing "Silent" disables the preview button
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ChannelSoundPicker from './ChannelSoundPicker';
import { getChannelSoundId } from '../utils/notificationSounds';

const CHANNELS = [
  { id: 0, name: 'Primary' },
  { id: 1, name: 'Secondary' },
];

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(async () => CHANNELS),
  },
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: null, sourceType: null }),
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

describe('ChannelSoundPicker', () => {
  beforeEach(() => {
    localStorage.clear();
    playSoundMock.mockClear();
  });

  it('renders a sound dropdown for each channel', async () => {
    render(<ChannelSoundPicker />);
    await waitFor(() => {
      expect(screen.getByLabelText('Primary')).toBeInTheDocument();
      expect(screen.getByLabelText('Secondary')).toBeInTheDocument();
    });
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

  it('plays the selected sound when preview is clicked', async () => {
    render(<ChannelSoundPicker />);
    const primary = (await screen.findByLabelText('Primary')) as HTMLSelectElement;
    fireEvent.change(primary, { target: { value: 'boop' } });

    // The i18n mock returns translation keys, so query by role rather than label text.
    const previewButtons = screen.getAllByRole('button');
    fireEvent.click(previewButtons[0]);

    expect(playSoundMock).toHaveBeenCalledWith('boop');
  });

  it('disables preview when a channel is set to Silent', async () => {
    render(<ChannelSoundPicker />);
    const primary = (await screen.findByLabelText('Primary')) as HTMLSelectElement;
    fireEvent.change(primary, { target: { value: 'none' } });

    // The i18n mock returns translation keys, so query by role rather than label text.
    const previewButtons = screen.getAllByRole('button');
    expect(previewButtons[0].closest('button')).toBeDisabled();
  });

  it('seeds the dropdown from a previously stored selection', async () => {
    localStorage.setItem('channelNotificationSound:1', 'arpeggio');
    render(<ChannelSoundPicker />);
    const secondary = (await screen.findByLabelText('Secondary')) as HTMLSelectElement;
    expect(secondary.value).toBe('arpeggio');
  });
});
