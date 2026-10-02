import { describe, it, expect } from 'vitest';
import { buildAdminCommandsPath, parseAdminDeepLink } from './adminDeepLink';

describe('buildAdminCommandsPath', () => {
  it('returns the bare /admin path when no node is given', () => {
    expect(buildAdminCommandsPath({})).toBe('/admin');
  });

  it('includes node (lower-cased)', () => {
    const path = buildAdminCommandsPath({ node: '!AABBCCDD' });
    const params = new URLSearchParams(path.split('?')[1]);
    expect(params.get('node')).toBe('!aabbccdd');
  });
});

describe('parseAdminDeepLink', () => {
  it('returns null when node is missing', () => {
    expect(parseAdminDeepLink(new URLSearchParams(''))).toBeNull();
  });

  it('round-trips a valid node id through build/parse', () => {
    const path = buildAdminCommandsPath({ node: '!aabbccdd' });
    const parsed = parseAdminDeepLink(new URLSearchParams(path.split('?')[1]));
    expect(parsed).toEqual({ node: '!aabbccdd' });
  });

  it('lower-cases an upper-case node id before validating/storing it', () => {
    const parsed = parseAdminDeepLink(new URLSearchParams('node=!AABBCCDD'));
    expect(parsed).toEqual({ node: '!aabbccdd' });
  });

  it('drops a malformed node id rather than passing it through', () => {
    expect(parseAdminDeepLink(new URLSearchParams('node=not-a-valid-id'))).toBeNull();
  });

  it('drops a node id with the wrong hex length', () => {
    expect(parseAdminDeepLink(new URLSearchParams('node=!aabbcc'))).toBeNull();
  });

  it('drops a 64-hex MeshCore-shaped id (admin deep link is Meshtastic-only)', () => {
    expect(parseAdminDeepLink(new URLSearchParams(`node=${'a'.repeat(64)}`))).toBeNull();
  });

  it('drops an empty node param', () => {
    expect(parseAdminDeepLink(new URLSearchParams('node='))).toBeNull();
  });
});
