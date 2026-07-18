/**
 * Unit tests for the compose-draft scoping helpers (#4183).
 *
 * These prove the core correctness/privacy guarantee: when the active compose
 * target changes, the draft is cleared so it can never be sent to the wrong
 * conversation — while draft-preserving cases (returning to the same
 * conversation, unrelated re-renders, and the send path) do NOT clear.
 */
import { describe, it, expect } from 'vitest';
import { getComposeConversationKey, nextComposeDraftState } from './composeDraft';

describe('getComposeConversationKey', () => {
  it('keys DM conversations by selected node in the messages tab', () => {
    expect(getComposeConversationKey('messages', '!aabbccdd', -1)).toBe('dm:!aabbccdd');
  });

  it('keys channel conversations by selected channel in the channels tab', () => {
    expect(getComposeConversationKey('channels', '', 3)).toBe('ch:3');
  });

  it('distinguishes an empty (no) DM selection from a concrete node', () => {
    expect(getComposeConversationKey('messages', '', -1)).toBe('dm:');
    expect(getComposeConversationKey('messages', '', -1)).not.toBe(
      getComposeConversationKey('messages', '!node', -1)
    );
  });

  it('returns null when no compose box is visible (non-messaging tab)', () => {
    expect(getComposeConversationKey('nodes', '!node', 3)).toBeNull();
    expect(getComposeConversationKey('settings', '', 0)).toBeNull();
  });
});

describe('nextComposeDraftState', () => {
  it('does not clear on initial mount (no previously tracked target)', () => {
    expect(nextComposeDraftState(null, 'dm:!a')).toEqual({ key: 'dm:!a', clear: false });
  });

  it('clears when switching between two different DMs (the reported bug)', () => {
    expect(nextComposeDraftState('dm:!a', 'dm:!b')).toEqual({ key: 'dm:!b', clear: true });
  });

  it('clears when switching between two different channels', () => {
    expect(nextComposeDraftState('ch:0', 'ch:2')).toEqual({ key: 'ch:2', clear: true });
  });

  it('clears when switching from a DM to a channel (privacy: DM draft into public channel)', () => {
    expect(nextComposeDraftState('dm:!a', 'ch:0')).toEqual({ key: 'ch:0', clear: true });
  });

  it('clears when switching from a channel to a DM', () => {
    expect(nextComposeDraftState('ch:0', 'dm:!a')).toEqual({ key: 'dm:!a', clear: true });
  });

  it('clears when deselecting a DM (selection cleared programmatically)', () => {
    expect(nextComposeDraftState('dm:!a', 'dm:')).toEqual({ key: 'dm:', clear: true });
  });

  it('does not clear when the same conversation is observed again (unrelated re-render)', () => {
    expect(nextComposeDraftState('dm:!a', 'dm:!a')).toEqual({ key: 'dm:!a', clear: false });
    expect(nextComposeDraftState('ch:1', 'ch:1')).toEqual({ key: 'ch:1', clear: false });
  });

  it('preserves the remembered target while on a non-messaging tab (null key)', () => {
    // Tab away from a DM to the Nodes tab: key becomes null, nothing cleared,
    // and the DM target is remembered.
    expect(nextComposeDraftState('dm:!a', null)).toEqual({ key: 'dm:!a', clear: false });
  });

  it('does not clear when returning to the SAME conversation after visiting another tab', () => {
    // dm:!a -> (nodes tab / null) -> back to dm:!a should keep the draft.
    const away = nextComposeDraftState('dm:!a', null);
    const back = nextComposeDraftState(away.key, 'dm:!a');
    expect(back).toEqual({ key: 'dm:!a', clear: false });
  });

  it('clears when a DIFFERENT conversation is opened after visiting another tab', () => {
    // dm:!a -> (nodes tab / null) -> channels ch:0 should clear.
    const away = nextComposeDraftState('dm:!a', null);
    const other = nextComposeDraftState(away.key, 'ch:0');
    expect(other).toEqual({ key: 'ch:0', clear: true });
  });
});
