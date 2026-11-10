import { describe, it, expect } from 'vitest';
import {
  meshcoreChannelMaxBytes,
  meshcoreMessageByteCap,
  MESHCORE_MAX_MESSAGE_BYTES_DM,
} from './meshcoreMessageLimits';

describe('meshcoreChannelMaxBytes', () => {
  it('gives 155 for a 3-byte name', () => {
    expect(meshcoreChannelMaxBytes('Bob')).toBe(155);
  });
  it('gives 127 for a 31-byte name', () => {
    expect(meshcoreChannelMaxBytes('a'.repeat(31))).toBe(127);
  });
  it('counts UTF-8 bytes, not characters', () => {
    // 4 chars x 3 bytes = 12 bytes -> 160 - 14
    expect(meshcoreChannelMaxBytes('日本語表')).toBe(146);
    // emoji is 4 bytes
    expect(meshcoreChannelMaxBytes('A😀')).toBe(160 - (5 + 2));
  });
  it('clamps a name over 31 bytes to the firmware limit', () => {
    expect(meshcoreChannelMaxBytes('a'.repeat(40))).toBe(127);
  });
  it('uses the worst case when the name is unknown', () => {
    expect(meshcoreChannelMaxBytes(undefined)).toBe(127);
    expect(meshcoreChannelMaxBytes(null)).toBe(127);
    expect(meshcoreChannelMaxBytes('')).toBe(127);
  });
});

describe('meshcoreMessageByteCap', () => {
  it('caps a DM at 160 (retries never pass attempt 3, so the 158 case does not apply)', () => {
    expect(MESHCORE_MAX_MESSAGE_BYTES_DM).toBe(160);
    expect(meshcoreMessageByteCap({ isDm: true, nodeName: 'Bob' })).toBe(160);
  });
  it('caps a channel send by node name', () => {
    expect(meshcoreMessageByteCap({ isDm: false, nodeName: 'Bob' })).toBe(155);
    expect(meshcoreMessageByteCap({ isDm: false })).toBe(127);
  });
});
