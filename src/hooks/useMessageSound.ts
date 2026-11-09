/**
 * Shared "play the configured sound for a new message" hook (P11 S9).
 *
 * One implementation serves Meshtastic (`useMessagingView`) and MeshCore
 * (`useMeshCore`). It checks the master audio toggle and the mute lists, then
 * plays the per-channel sound scoped to the source. Direct messages and
 * MeshCore room posts use the DM pseudo-channel (-1).
 */
import { useCallback } from 'react';
import { useOptionalMuteSettings } from '../contexts/SettingsContext';
import { playChannelSound } from '../utils/notificationSounds';

/** DM pseudo-channel id (App.tsx convention). Rooms share it. */
export const DM_SOUND_CHANNEL_ID = -1;

export interface PlayForMessageArgs {
  /** Channel index. Ignored for a DM (the -1 sound plays). */
  channelId: number;
  isDM: boolean;
  /** DM: the peer's key or node id for `isDMMuted`. Channel: the index for `isChannelMuted` (defaults to `channelId`). */
  muteKey?: string | number;
  /** Own messages never play a sound. */
  isOwn?: boolean;
}

/** Returns true when a sound was started. */
export function useMessageSound(sourceId: string | null | undefined) {
  const settings = useOptionalMuteSettings();
  const enabled = !!settings?.enableAudioNotifications;
  const isChannelMuted = settings?.isChannelMuted;
  const isDMMuted = settings?.isDMMuted;

  const playForMessage = useCallback(
    ({ channelId, isDM, muteKey, isOwn }: PlayForMessageArgs): boolean => {
      if (isOwn || !enabled) return false;
      const muted = isDM
        ? (isDMMuted?.(String(muteKey ?? '')) ?? false)
        : (isChannelMuted?.(Number(muteKey ?? channelId)) ?? false);
      if (muted) return false;
      return playChannelSound(isDM ? DM_SOUND_CHANNEL_ID : channelId, sourceId);
    },
    [enabled, isChannelMuted, isDMMuted, sourceId],
  );

  return { playForMessage };
}

interface MeshCoreSoundMessage {
  fromPublicKey: string;
  toPublicKey?: string;
  messageType?: string;
  reactionEmoji?: string | null;
  filtered?: 'ignore' | 'block';
}

/**
 * Map a live MeshCore message to `playForMessage` args, or null when it must
 * stay silent (reaction, ignored/blocked, own). A channel message comes from
 * the synthetic `channel-<idx>` sender; a room post plays the DM sound (-1)
 * and mutes by room key; a DM mutes by peer key.
 */
export function meshcoreSoundArgs(
  msg: MeshCoreSoundMessage,
  selfPublicKey: string | null | undefined,
  /** Maps a peer key (possibly a 12-hex prefix) to the canonical key DM/room mutes are stored under. */
  canonicalize: (key: string) => string = (k) => k,
): PlayForMessageArgs | null {
  if (msg.filtered || msg.reactionEmoji) return null;
  const isOwn =
    (!!selfPublicKey && msg.fromPublicKey === selfPublicKey) ||
    (!msg.fromPublicKey.startsWith('channel-') && !!msg.toPublicKey?.startsWith('channel-'));
  if (isOwn) return null;
  const m = /^channel-(\d+)$/.exec(msg.fromPublicKey);
  if (m) return { channelId: Number(m[1]), isDM: false, muteKey: Number(m[1]) };
  if (msg.messageType === 'room_post') {
    return { channelId: DM_SOUND_CHANNEL_ID, isDM: true, muteKey: canonicalize(msg.toPublicKey ?? msg.fromPublicKey) };
  }
  return { channelId: DM_SOUND_CHANNEL_ID, isDM: true, muteKey: canonicalize(msg.fromPublicKey) };
}
