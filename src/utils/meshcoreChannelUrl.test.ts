import { describe, it, expect } from 'vitest';
import {
  encodeMeshcoreChannelUrl,
  decodeMeshcoreChannelUrl,
  isMeshcoreChannelUrl,
  maskMeshcoreSecret,
  lowestFreeMeshcoreSlot,
  planMeshcoreChannelImport,
} from './meshcoreChannelUrl.js';
import { deriveHashtagSecretHex } from './meshcoreHelpers.js';

const SECRET = '00112233445566778899aabbccddeeff';

describe('meshcoreChannelUrl encode/decode', () => {
  it('round-trips name, secret and scope', async () => {
    const enc = encodeMeshcoreChannelUrl({ name: 'My Chan', secretHex: SECRET, regionScope: 'muenchen' });
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    expect(enc.url).toBe(`meshcore://channel/add?name=My%20Chan&secret=${SECRET}&region_scope=muenchen`);
    const dec = await decodeMeshcoreChannelUrl(enc.url);
    expect(dec).toEqual({ ok: true, derived: false, channel: { name: 'My Chan', secretHex: SECRET, regionScope: 'muenchen' } });
  });

  it('omits region_scope when none, and lowercases hex', async () => {
    const enc = encodeMeshcoreChannelUrl({ name: 'a', secretHex: SECRET.toUpperCase() });
    expect(enc.ok && enc.url).toBe(`meshcore://channel/add?name=a&secret=${SECRET}`);
  });

  it('URL-encodes # in hashtag names and decodes it back', async () => {
    const enc = encodeMeshcoreChannelUrl({ name: '#general', secretHex: SECRET });
    expect(enc.ok && enc.url).toContain('name=%23general');
    const dec = await decodeMeshcoreChannelUrl((enc as { url: string }).url);
    expect(dec.ok && dec.channel.name).toBe('#general');
  });

  it('accepts an unencoded # in the name', async () => {
    const dec = await decodeMeshcoreChannelUrl(`meshcore://channel/add?name=#room&secret=${SECRET}`);
    expect(dec.ok && dec.channel.name).toBe('#room');
  });

  it('derives the secret for a hashtag name with no secret', async () => {
    const dec = await decodeMeshcoreChannelUrl('meshcore://channel/add?name=%23general');
    expect(dec.ok).toBe(true);
    if (!dec.ok) return;
    expect(dec.derived).toBe(true);
    expect(dec.channel.secretHex).toBe(await deriveHashtagSecretHex('#general'));
    expect(dec.channel.secretHex).toMatch(/^[0-9a-f]{32}$/);
  });

  it('requires a secret for a non-hashtag name', async () => {
    const dec = await decodeMeshcoreChannelUrl('meshcore://channel/add?name=plain');
    expect(dec).toMatchObject({ ok: false, code: 'SECRET_REQUIRED' });
  });

  it('strips a leading # from region_scope', async () => {
    const dec = await decodeMeshcoreChannelUrl(`meshcore://channel/add?name=a&secret=${SECRET}&region_scope=%23bayern`);
    expect(dec.ok && dec.channel.regionScope).toBe('bayern');
  });

  it.each([
    ['bad hex', `meshcore://channel/add?name=a&secret=${'zz'.repeat(16)}`, 'SECRET_BAD_HEX'],
    ['all zero', `meshcore://channel/add?name=a&secret=${'0'.repeat(32)}`, 'SECRET_ALL_ZERO'],
    ['short', 'meshcore://channel/add?name=a&secret=abcd', 'SECRET_WRONG_LENGTH'],
    ['32-byte secret', `meshcore://channel/add?name=a&secret=${'ab'.repeat(32)}`, 'SECRET_WRONG_LENGTH'],
    ['no name', `meshcore://channel/add?secret=${SECRET}`, 'NAME_REQUIRED'],
    ['long name', `meshcore://channel/add?name=${'x'.repeat(32)}&secret=${SECRET}`, 'NAME_TOO_LONG'],
    ['bad scope', `meshcore://channel/add?name=a&secret=${SECRET}&region_scope=a%20b`, 'SCOPE_INVALID'],
    ['wrong scheme', `https://example.com/?name=a&secret=${SECRET}`, 'WRONG_SCHEME'],
    ['meshtastic url', 'https://meshtastic.org/e/#CgMSAQE', 'WRONG_SCHEME'],
    ['wrong path', `meshcore://contact/add?name=a&secret=${SECRET}`, 'WRONG_SCHEME'],
  ])('rejects %s', async (_label, url, code) => {
    expect(await decodeMeshcoreChannelUrl(url)).toMatchObject({ ok: false, code });
  });

  it('encode rejects invalid channels', () => {
    expect(encodeMeshcoreChannelUrl({ name: 'a', secretHex: '0'.repeat(32) })).toMatchObject({ ok: false, code: 'SECRET_ALL_ZERO' });
    expect(encodeMeshcoreChannelUrl({ name: 'a', secretHex: 'ab'.repeat(32) })).toMatchObject({ ok: false, code: 'SECRET_WRONG_LENGTH' });
  });

  it('isMeshcoreChannelUrl dispatches on scheme', () => {
    expect(isMeshcoreChannelUrl(`  meshcore://channel/add?name=a`)).toBe(true);
    expect(isMeshcoreChannelUrl('https://meshtastic.org/e/#x')).toBe(false);
  });

  it('masks a secret', () => {
    expect(maskMeshcoreSecret(SECRET)).toBe('00' + '*'.repeat(28) + 'ff');
  });
});

describe('slot planning', () => {
  it('picks the lowest free slot >= 1 and never 0', () => {
    expect(lowestFreeMeshcoreSlot([], 8)).toBe(1);
    expect(lowestFreeMeshcoreSlot([1, 2, 4], 8)).toBe(3);
  });

  it('respects maxChannels with no 255 fallback', () => {
    expect(lowestFreeMeshcoreSlot([1, 2, 3], 4)).toBeNull();
    expect(lowestFreeMeshcoreSlot([1, 2, 3, 4, 5, 6, 7], 8)).toBeNull();
    expect(lowestFreeMeshcoreSlot([], 1)).toBeNull();
  });

  it('plan: existing for an equal secret, new for free, full when none', () => {
    const slots = [
      { id: 0, name: 'Public', secretHex: '8b3387e9c5cdea6ac9e5edbaa115cd72' },
      { id: 1, name: 'a', secretHex: SECRET },
      { id: 2, name: '', secretHex: '' },
    ];
    expect(planMeshcoreChannelImport(SECRET.toUpperCase(), slots, 8)).toEqual({ kind: 'existing', slot: 1 });
    expect(planMeshcoreChannelImport('ab'.repeat(16), slots, 8)).toEqual({ kind: 'new', slot: 2 });
    expect(planMeshcoreChannelImport('ab'.repeat(16), slots, 2)).toEqual({ kind: 'full', maxChannels: 2 });
  });
});
