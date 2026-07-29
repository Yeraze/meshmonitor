/**
 * Parser + matcher tests for the MeshCore Auto-Acknowledge sender ignore
 * list (#4391).
 */
import { describe, it, expect } from 'vitest';
import {
  parseMeshCoreIgnoreList,
  isMeshCoreIgnoreListEmpty,
  isMeshCoreSenderIgnored,
} from './meshcoreAutoAckIgnore.js';

const FULL_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const DM_PREFIX = 'a1b2c3d4e5f6'; // 6-byte prefix, the shape a DM actually carries

describe('parseMeshCoreIgnoreList', () => {
  it('returns an empty list for null/undefined/blank input', () => {
    for (const raw of [null, undefined, '', '   ', '\n\n', ' , ,\n']) {
      const list = parseMeshCoreIgnoreList(raw);
      expect(isMeshCoreIgnoreListEmpty(list)).toBe(true);
    }
  });

  it('splits on commas and newlines', () => {
    const list = parseMeshCoreIgnoreList('aabb,ccdd\neeff\r\n0011');
    expect(list.keys).toEqual(['aabb', 'ccdd', 'eeff', '0011']);
  });

  it('keeps names with internal spaces intact (unlike the Meshtastic parser)', () => {
    const list = parseMeshCoreIgnoreList('Echo Bot, Weather Relay\n  Alice  MeshCore  ');
    expect(list.names).toEqual(['echo bot', 'weather relay', 'alice meshcore']);
  });

  it('lowercases hex entries and strips an optional leading "!"', () => {
    const list = parseMeshCoreIgnoreList('!AABBCCDD');
    expect(list.keys).toEqual(['aabbccdd']);
  });

  it('ignores hex entries shorter than two characters', () => {
    const list = parseMeshCoreIgnoreList('a');
    expect(list.keys).toEqual([]);
    expect(list.names).toEqual(['a']);
  });

  it('files a hex-looking entry under BOTH keys and names', () => {
    const list = parseMeshCoreIgnoreList('beef');
    expect(list.keys).toEqual(['beef']);
    expect(list.names).toEqual(['beef']);
  });

  it('de-duplicates entries', () => {
    const list = parseMeshCoreIgnoreList('AABB\naabb, aabb');
    expect(list.keys).toEqual(['aabb']);
  });
});

describe('isMeshCoreSenderIgnored', () => {
  it('never matches when the list is empty', () => {
    const list = parseMeshCoreIgnoreList('');
    expect(isMeshCoreSenderIgnored(list, { publicKey: FULL_KEY, names: ['Echo Bot'] })).toBe(false);
  });

  it('matches a stored full key against the short prefix a DM carries', () => {
    const list = parseMeshCoreIgnoreList(FULL_KEY);
    expect(isMeshCoreSenderIgnored(list, { publicKey: DM_PREFIX })).toBe(true);
  });

  it('matches a stored short prefix against a full sender key', () => {
    const list = parseMeshCoreIgnoreList('a1b2c3');
    expect(isMeshCoreSenderIgnored(list, { publicKey: FULL_KEY })).toBe(true);
  });

  it('does not match an unrelated key', () => {
    const list = parseMeshCoreIgnoreList(FULL_KEY);
    expect(isMeshCoreSenderIgnored(list, { publicKey: 'ffeeddccbbaa' })).toBe(false);
  });

  it('matches a contact name ignoring case and extra whitespace', () => {
    const list = parseMeshCoreIgnoreList('echo bot');
    expect(isMeshCoreSenderIgnored(list, { names: ['  ECHO   Bot '] })).toBe(true);
  });

  it('matches any of the candidate names (message name or resolved contact)', () => {
    const list = parseMeshCoreIgnoreList('Weather Relay');
    expect(isMeshCoreSenderIgnored(list, { names: [undefined, null, 'Weather Relay'] })).toBe(true);
  });

  it('does not partially match a name', () => {
    const list = parseMeshCoreIgnoreList('Echo');
    expect(isMeshCoreSenderIgnored(list, { names: ['Echo Bot'] })).toBe(false);
  });

  it('never key-matches the synthetic channel-<idx> sender key', () => {
    // Channel packets carry no sender key; the manager synthesises one.
    const list = parseMeshCoreIgnoreList('ch,cha,channel');
    expect(isMeshCoreSenderIgnored(list, { publicKey: 'channel-3' })).toBe(false);
  });

  it('still excludes a channel sender by name', () => {
    const list = parseMeshCoreIgnoreList('Echo Bot');
    expect(isMeshCoreSenderIgnored(list, { publicKey: 'channel-3', names: ['Echo Bot'] })).toBe(true);
  });
});
