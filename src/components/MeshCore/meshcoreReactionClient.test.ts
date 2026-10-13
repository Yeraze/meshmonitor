import { describe, it, expect } from 'vitest';
import {
  reactionEmojiOptions,
  pendingReactionId,
  buildOptimisticReaction,
  isReactableRow,
} from './meshcoreReactionClient';
import { DEFAULT_TAPBACK_EMOJIS } from '../EmojiPickerModal/EmojiPickerModal';
import { isReactionEmoji } from '../../utils/meshcoreReactions';
import type { MeshCoreMessage } from './hooks/useMeshCore';

const SELF = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const NOW_MS = 1_700_000_000_000;

const channelMsg = (extra: Partial<MeshCoreMessage> = {}): MeshCoreMessage => ({
  id: 'm1', fromPublicKey: 'channel-2', toPublicKey: 'channel-2', fromName: 'Alice',
  text: 'hello', timestamp: NOW_MS, senderTimestamp: Math.floor(NOW_MS / 1000), ...extra,
});
const dmMsg = (extra: Partial<MeshCoreMessage> = {}): MeshCoreMessage => ({
  id: 'd1', fromPublicKey: PEER, toPublicKey: SELF, text: 'hi',
  timestamp: NOW_MS, senderTimestamp: Math.floor(NOW_MS / 1000), ...extra,
});

describe('reactionEmojiOptions', () => {
  it('keeps only sendable emoji from the configured list', () => {
    const out = reactionEmojiOptions([{ emoji: '👍', title: 'up' }, { emoji: '7', title: 'digit' }]);
    expect(out.map(e => e.emoji)).toEqual(['👍']);
  });
  it('falls back to the defaults when nothing is configured or nothing passes', () => {
    const expected = DEFAULT_TAPBACK_EMOJIS.filter(e => isReactionEmoji(e.emoji));
    expect(expected.length).toBeGreaterThan(0);
    expect(reactionEmojiOptions(undefined)).toEqual(expected);
    expect(reactionEmojiOptions([])).toEqual(expected);
    expect(reactionEmojiOptions([{ emoji: '7', title: 'digit' }])).toEqual(expected);
  });
});

describe('pendingReactionId', () => {
  it('folds the variation selector', () => {
    expect(pendingReactionId('m1', '❤️')).toBe(pendingReactionId('m1', '❤'));
    expect(pendingReactionId('m1', '👍')).toBe('pending-reaction-m1-👍');
  });
});

describe('buildOptimisticReaction', () => {
  const self = { publicKey: SELF, name: 'Me' };
  it('builds a channel row', () => {
    const r = buildOptimisticReaction(channelMsg(), '👍', self, 5);
    expect(r).toMatchObject({
      id: pendingReactionId('m1', '👍'), fromPublicKey: SELF, fromName: 'Me', toPublicKey: 'channel-2',
      text: '👍', reactionEmoji: '👍', reactionTargetId: 'm1', reactionFormat: 'mc1-channel',
      reactionPending: true, timestamp: 5,
    });
  });
  it('addresses a DM reaction to the peer when the target came in', () => {
    expect(buildOptimisticReaction(dmMsg(), '👍', self, 5)).toMatchObject({
      toPublicKey: PEER, reactionFormat: 'mc1-dm',
    });
  });
  it('addresses a DM reaction to the peer when the target is ours', () => {
    const r = buildOptimisticReaction(dmMsg({ fromPublicKey: SELF, toPublicKey: PEER }), '👍', self, 5);
    expect(r.toPublicKey).toBe(PEER);
  });
});

describe('isReactableRow', () => {
  it('accepts a normal channel row and a normal DM row', () => {
    expect(isReactableRow(channelMsg(), SELF)).toBe(true);
    expect(isReactableRow(dmMsg(), SELF)).toBe(true);
  });
  it('rejects ignored, reaction, room post and no-hash rows', () => {
    expect(isReactableRow(channelMsg({ filtered: 'ignore' }), SELF)).toBe(false);
    expect(isReactableRow(channelMsg({ reactionEmoji: '👍' }), SELF)).toBe(false);
    expect(isReactableRow(dmMsg({ messageType: 'room_post' }), SELF)).toBe(false);
    expect(isReactableRow(dmMsg({ senderTimestamp: undefined, mc1Hash: undefined, id: 'sent-1' }), SELF)).toBe(false);
  });
  it('rejects a channel row with no sender name', () => {
    expect(isReactableRow(channelMsg({ fromName: undefined }), SELF)).toBe(false);
  });
});
