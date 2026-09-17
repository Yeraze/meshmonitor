/**
 * Channel PSK shorthand, shared by the setChannel admin message builder and the
 * local channel row it mirrors into the database (#5183).
 *
 * Admin Commands accepts `none`, `default` and `simpleN` alongside a raw base64
 * key. Both the bytes sent to the device and the base64 stored for the channel
 * row must come from ONE translation — otherwise the stored PSK stops matching
 * what the device reports on its next sync, and channel-move detection (which
 * matches on PSK + name) sees a different channel.
 */

/** Translate a PSK as entered (shorthand or base64) into the key bytes. */
export function channelPskToBytes(psk: string): Buffer {
  if (psk === 'none') return Buffer.from([0]);
  if (psk === 'default') return Buffer.from([1]);
  if (psk.startsWith('simple')) {
    const num = parseInt(psk.replace('simple', ''), 10);
    return Buffer.from([num + 1]);
  }
  return Buffer.from(psk, 'base64');
}

/**
 * The base64 form stored on a channel row, matching how a device-reported
 * channel is stored (`Buffer.from(settings.psk).toString('base64')`). An empty
 * key yields `undefined`, as the sync path does.
 */
export function channelPskToStoredBase64(psk: string): string | undefined {
  const bytes = channelPskToBytes(psk);
  return bytes.length > 0 ? bytes.toString('base64') : undefined;
}
