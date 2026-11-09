/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMessageSound, meshcoreSoundArgs } from './useMessageSound';

const { settings, playChannelSound } = vi.hoisted(() => ({
  settings: { current: null as unknown },
  playChannelSound: vi.fn(() => true),
}));
vi.mock('../contexts/SettingsContext', () => ({ useOptionalMuteSettings: () => settings.current }));
vi.mock('../utils/notificationSounds', () => ({ playChannelSound }));

function setSettings(over: Record<string, unknown> = {}) {
  settings.current = {
    enableAudioNotifications: true,
    isChannelMuted: () => false,
    isDMMuted: () => false,
    ...over,
  };
}

describe('useMessageSound', () => {
  beforeEach(() => {
    playChannelSound.mockClear();
    setSettings();
  });

  it('plays the channel sound scoped to the source', () => {
    const { result } = renderHook(() => useMessageSound('s1'));
    expect(result.current.playForMessage({ channelId: 3, isDM: false })).toBe(true);
    expect(playChannelSound).toHaveBeenCalledWith(3, 's1');
  });

  it('plays the -1 sound for a DM', () => {
    const { result } = renderHook(() => useMessageSound('s1'));
    result.current.playForMessage({ channelId: 5, isDM: true, muteKey: 'peer' });
    expect(playChannelSound).toHaveBeenCalledWith(-1, 's1');
  });

  it('stays silent when muted, own, or the master toggle is off', () => {
    setSettings({ isChannelMuted: () => true, isDMMuted: () => true });
    const { result } = renderHook(() => useMessageSound('s1'));
    result.current.playForMessage({ channelId: 1, isDM: false });
    result.current.playForMessage({ channelId: 1, isDM: true, muteKey: 'p' });
    setSettings();
    const r2 = renderHook(() => useMessageSound('s1'));
    r2.result.current.playForMessage({ channelId: 1, isDM: false, isOwn: true });
    setSettings({ enableAudioNotifications: false });
    const r3 = renderHook(() => useMessageSound('s1'));
    r3.result.current.playForMessage({ channelId: 1, isDM: false });
    expect(playChannelSound).not.toHaveBeenCalled();
  });

  it('stays silent without a settings provider', () => {
    settings.current = null;
    const { result } = renderHook(() => useMessageSound('s1'));
    expect(result.current.playForMessage({ channelId: 1, isDM: false })).toBe(false);
  });
});

describe('meshcoreSoundArgs', () => {
  it('maps channel, DM and room messages', () => {
    expect(meshcoreSoundArgs({ fromPublicKey: 'channel-12' }, 'me')).toEqual({ channelId: 12, isDM: false, muteKey: 12 });
    expect(meshcoreSoundArgs({ fromPublicKey: 'peer', toPublicKey: 'me' }, 'me')).toEqual({ channelId: -1, isDM: true, muteKey: 'peer' });
    expect(meshcoreSoundArgs({ fromPublicKey: 'author', toPublicKey: 'room', messageType: 'room_post' }, 'me')).toEqual({ channelId: -1, isDM: true, muteKey: 'room' });
  });

  it('skips own, filtered and reaction messages', () => {
    expect(meshcoreSoundArgs({ fromPublicKey: 'me', toPublicKey: 'peer' }, 'me')).toBeNull();
    expect(meshcoreSoundArgs({ fromPublicKey: 'x', toPublicKey: 'channel-0' }, 'me')).toBeNull();
    expect(meshcoreSoundArgs({ fromPublicKey: 'channel-1', filtered: 'ignore' }, 'me')).toBeNull();
    expect(meshcoreSoundArgs({ fromPublicKey: 'channel-1', reactionEmoji: '👍' }, 'me')).toBeNull();
  });
});
