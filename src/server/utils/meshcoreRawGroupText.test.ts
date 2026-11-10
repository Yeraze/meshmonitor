import { describe, it, expect } from 'vitest';
import {
  buildRawGroupTextFrame,
  RawFrameTooLargeError,
  MESHCORE_MAX_FRAME_BYTES,
} from './meshcoreRawGroupText.js';
import { tryDecodeGroupTextPayload } from './meshcoreGroupEcho.js';
import { computeTransportCode, scopeTransportKey } from '../meshcoreScopeResolve.js';
import { meshcoreChannelTextCap } from '../../utils/meshcoreMessageLimits.js';

const SECRET = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const TS = 1_700_000_000;

describe('buildRawGroupTextFrame', () => {
  it('builds an unscoped flood frame that decodes back', () => {
    const r = buildRawGroupTextFrame({
      secret: SECRET, senderName: 'Bot', text: 'hello', ts: TS, pathHashMode: 0, transportKey: null,
    });
    expect([...r.frame.subarray(0, 4)]).toEqual([0x41, 0x01, 0x15, 0x00]);
    expect(r.wireText).toBe('Bot: hello');
    expect(r.frame.subarray(4).toString('hex')).toBe(r.payloadHex);
    expect(tryDecodeGroupTextPayload(r.payloadHex, SECRET)).toEqual({ timestamp: TS, body: 'Bot: hello' });
  });

  it('is deterministic (same inputs, same bytes)', () => {
    const a = buildRawGroupTextFrame({ secret: SECRET, senderName: 'A', text: 'x', ts: TS, pathHashMode: 1, transportKey: null });
    const b = buildRawGroupTextFrame({ secret: SECRET, senderName: 'A', text: 'x', ts: TS, pathHashMode: 1, transportKey: null });
    expect(a.frame.equals(b.frame)).toBe(true);
  });

  it('writes the path hash mode into the top two bits of path_len', () => {
    for (const [mode, byte] of [[0, 0x00], [1, 0x40], [2, 0x80], [3, 0x80], [-1, 0x00]]) {
      const r = buildRawGroupTextFrame({ secret: SECRET, senderName: 'A', text: 'x', ts: TS, pathHashMode: mode, transportKey: null });
      expect(r.frame[3]).toBe(byte);
    }
  });

  it('builds a transport flood frame whose code matches computeTransportCode', () => {
    const r = buildRawGroupTextFrame({
      secret: SECRET, senderName: 'Bot', text: 'hi', ts: TS, pathHashMode: 0,
      transportKey: scopeTransportKey('muenchen'),
    });
    expect(r.frame[2]).toBe(0x14);
    expect(r.frame.readUInt16LE(3)).toBe(computeTransportCode('muenchen', 0x05, r.payloadHex));
    expect(r.frame.readUInt16LE(5)).toBe(0);
    expect(r.frame[7]).toBe(0x00);
    expect(r.frame.subarray(8).toString('hex')).toBe(r.payloadHex);
  });

  it('fits in 176 bytes at the raw cap, scoped and unscoped, for several names', () => {
    for (const name of ['A', 'Bot', 'é'.repeat(15), 'x'.repeat(31)]) {
      const cap = meshcoreChannelTextCap(name, { raw: true });
      for (const key of [null, scopeTransportKey('r')]) {
        const r = buildRawGroupTextFrame({ secret: SECRET, senderName: name, text: 'a'.repeat(cap), ts: TS, pathHashMode: 2, transportKey: key });
        expect(r.frame.length).toBeLessThanOrEqual(MESHCORE_MAX_FRAME_BYTES);
        expect(() =>
          buildRawGroupTextFrame({ secret: SECRET, senderName: name, text: 'a'.repeat(cap + 1), ts: TS, pathHashMode: 2, transportKey: key }),
        ).toThrow(RawFrameTooLargeError);
      }
    }
  });
});

describe('meshcoreChannelTextCap', () => {
  it('raw is 5 below the normal cap', () => {
    expect(meshcoreChannelTextCap('Bot', { raw: false })).toBe(155);
    expect(meshcoreChannelTextCap('Bot', { raw: true })).toBe(150);
    expect(meshcoreChannelTextCap('é', { raw: true })).toBe(155 - 4);
  });
});
