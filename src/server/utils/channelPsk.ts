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

/**
 * "Encryption off" PSK (base64 of the single byte 0x00, the `none` shorthand).
 * Firmware turns encryption off for it on any role. A 0-byte PSK is NOT the
 * same: on a SECONDARY channel the firmware borrows the primary's key for it
 * (`Channels::getKey`), so a cleared key is written as this byte (#5826).
 */
export const NO_ENCRYPTION_PSK = 'AA==';

/** Translate a PSK as entered (shorthand or base64) into the key bytes. */
export function channelPskToBytes(psk: string): Buffer {
  if (psk === 'none') return Buffer.from([0]);
  if (psk === 'default') return Buffer.from([1]);
  if (psk.startsWith('simple')) {
    const suffix = psk.slice('simple'.length);
    const num = Number(suffix);
    // `simple` with no number would otherwise become Buffer.from([NaN]) = [0],
    // silently the "no encryption" key.
    if (!/^\d+$/.test(suffix) || num > 254) {
      throw new Error(`Invalid simple PSK "${psk}": expected simple0 to simple254`);
    }
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
