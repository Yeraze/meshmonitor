/**
 * Web Push payload size guard (#6278).
 */
import { describe, it, expect } from 'vitest';
import { fitWebPushPayload, WEB_PUSH_PAYLOAD_MAX_BYTES } from './pushPayloadSize.js';

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

describe('fitWebPushPayload', () => {
  it('returns a payload that fits unchanged (same object)', () => {
    const payload = { title: 't', body: 'short', data: { type: 'channel' } };
    expect(fitWebPushPayload(payload)).toBe(payload);
  });

  it('shortens a body of 4-byte characters until the payload fits', () => {
    const payload = { title: 'Title', body: '😀'.repeat(1000), data: { type: 'channel', channelId: 1 }, tag: 'x' };
    expect(bytes(payload)).toBeGreaterThan(WEB_PUSH_PAYLOAD_MAX_BYTES);
    const fitted = fitWebPushPayload(payload);
    expect(bytes(fitted)).toBeLessThanOrEqual(WEB_PUSH_PAYLOAD_MAX_BYTES);
    expect(fitted.body.endsWith('...')).toBe(true);
    expect(fitted.title).toBe('Title');
    expect(fitted.data).toEqual(payload.data);
    // No lone surrogate: UTF-8 round trip is lossless.
    expect(Buffer.from(fitted.body, 'utf8').toString('utf8')).toBe(fitted.body);
    // The original is not mutated.
    expect(payload.body).toBe('😀'.repeat(1000));
  });

  it('copes with a body of characters that JSON escapes', () => {
    const payload = { title: 't', body: '"\\'.repeat(3000) };
    const fitted = fitWebPushPayload(payload);
    expect(bytes(fitted)).toBeLessThanOrEqual(WEB_PUSH_PAYLOAD_MAX_BYTES);
  });
});
