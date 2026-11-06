import { describe, it, expect } from 'vitest';
import { meshcoreChannelKind, MESHCORE_PUBLIC_SLOT } from './meshcoreChannelKind';

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
});
