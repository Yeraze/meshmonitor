import { describe, it, expect } from 'vitest';
import {
  meshcoreChannelKind,
  meshcoreSecretToHex,
  MESHCORE_PUBLIC_SLOT,
  MESHCORE_PUBLIC_CHANNEL_SECRET_HEX,
} from './meshcoreChannelKind';
import { MESHCORE_PUBLIC_CHANNEL_SECRET } from '../server/utils/meshcoreGroupEcho';

const PUBLIC_B64 = 'izOH6cXN6mrJ5e26oRXNcg==';
const PRIVATE_B64 = 'AAECAwQFBgcICQoLDA0ODw==';

describe('meshcoreChannelKind (#6228)', () => {
  it('classifies slot 0 as public regardless of name', () => {
    expect(meshcoreChannelKind({ id: 0, name: 'Public' })).toBe('public');
    expect(meshcoreChannelKind({ id: 0, name: '' })).toBe('public');
    expect(meshcoreChannelKind({ id: 0, name: null })).toBe('public');
    // Slot id wins over the name — a hashtag-looking name in slot 0 is public.
    expect(meshcoreChannelKind({ id: 0, name: '#general' })).toBe('public');
  });

  it('classifies a #-prefixed name in slots 1+ as hashtag', () => {
    expect(meshcoreChannelKind({ id: 1, name: '#general' })).toBe('hashtag');
    expect(meshcoreChannelKind({ id: 7, name: '  #test' })).toBe('hashtag');
    expect(meshcoreChannelKind({ id: 2, name: '#' })).toBe('hashtag');
  });

  it('classifies everything else in slots 1+ as private', () => {
    expect(meshcoreChannelKind({ id: 1, name: 'Family' })).toBe('private');
    expect(meshcoreChannelKind({ id: 3, name: '' })).toBe('private');
    expect(meshcoreChannelKind({ id: 4, name: null })).toBe('private');
    expect(meshcoreChannelKind({ id: 5, name: undefined })).toBe('private');
  });

  it('exports the Public slot constant', () => {
    expect(MESHCORE_PUBLIC_SLOT).toBe(0);
  });

  // #4173 review L18: when the channel secret is known it decides, not the slot.
  describe('with a known PSK', () => {
    it('matches the server copy of the Public secret', () => {
      expect(MESHCORE_PUBLIC_CHANNEL_SECRET_HEX).toBe(Buffer.from(MESHCORE_PUBLIC_CHANNEL_SECRET).toString('hex'));
      expect(meshcoreSecretToHex(PUBLIC_B64)).toBe(MESHCORE_PUBLIC_CHANNEL_SECRET_HEX);
      expect(meshcoreSecretToHex(MESHCORE_PUBLIC_CHANNEL_SECRET_HEX.toUpperCase())).toBe(MESHCORE_PUBLIC_CHANNEL_SECRET_HEX);
    });

    it('treats the Public key in any slot as public', () => {
      expect(meshcoreChannelKind({ id: 3, name: 'Copy of public', psk: PUBLIC_B64 })).toBe('public');
      expect(meshcoreChannelKind({ id: 2, name: '#general', psk: PUBLIC_B64 })).toBe('public');
    });

    it('does not show slot 0 as public when it holds another key', () => {
      expect(meshcoreChannelKind({ id: 0, name: 'Family', psk: PRIVATE_B64 })).toBe('private');
      expect(meshcoreChannelKind({ id: 0, name: '#ops', psk: PRIVATE_B64 })).toBe('hashtag');
    });

    it('falls back to the slot rule when slot 0 carries no usable PSK', () => {
      expect(meshcoreChannelKind({ id: 0, name: 'Public', psk: null })).toBe('public');
      expect(meshcoreChannelKind({ id: 0, name: 'Public', psk: '' })).toBe('public');
      expect(meshcoreChannelKind({ id: 0, name: 'Public', psk: 'AAAAAAAAAAAAAAAAAAAAAA==' })).toBe('public');
      expect(meshcoreChannelKind({ id: 1, name: 'Family', psk: PRIVATE_B64 })).toBe('private');
    });
  });
});
