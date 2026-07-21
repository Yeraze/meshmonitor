/**
 * @vitest-environment jsdom
 *
 * jsdom is required only because importing the page module pulls in its CSS and
 * React dependencies; `resolveReplyPreview` itself is pure.
 *
 * #4245 — Unified Messages reply preview resolution.
 *
 * Before this fix the page did `parent && (...)`, so a message whose parent
 * packet was never received rendered identically to a message that was never a
 * reply — `replyId` was silently dropped. These tests pin the three-state
 * distinction that the UI now depends on.
 */
import { describe, it, expect } from 'vitest';
import { resolveReplyPreview } from './UnifiedMessagesPage';

// Minimal structural stand-in; resolveReplyPreview only ever reads the object
// back out of the map, so the extra UnifiedMessage fields are irrelevant here.
const parentMsg = { dedupKey: 'p1', packetId: 111, text: 'the original' } as never;

describe('resolveReplyPreview (#4245)', () => {
  it('returns "none" when the message is not a reply', () => {
    const map = new Map([[111, parentMsg]]);
    expect(resolveReplyPreview(null, map)).toEqual({ kind: 'none' });
    expect(resolveReplyPreview(undefined, map)).toEqual({ kind: 'none' });
  });

  it('returns "resolved" with the parent when the parent packet is present', () => {
    const map = new Map([[111, parentMsg]]);
    expect(resolveReplyPreview(111, map)).toEqual({ kind: 'resolved', parent: parentMsg });
  });

  it('returns "unknown" when replyId is set but the parent was never received', () => {
    const map = new Map([[111, parentMsg]]);
    // 999 was never stored — the regression this issue was filed for.
    expect(resolveReplyPreview(999, map)).toEqual({ kind: 'unknown' });
  });

  it('returns "unknown" against a completely empty store, not "none"', () => {
    expect(resolveReplyPreview(42, new Map())).toEqual({ kind: 'unknown' });
  });

  it('treats replyId 0 as a real reply rather than a falsy non-reply', () => {
    // Guards the `!= null` check against regressing to a truthiness test:
    // packet id 0 is falsy but is still a reply target.
    expect(resolveReplyPreview(0, new Map())).toEqual({ kind: 'unknown' });
    const map = new Map([[0, parentMsg]]);
    expect(resolveReplyPreview(0, map)).toEqual({ kind: 'resolved', parent: parentMsg });
  });
});
