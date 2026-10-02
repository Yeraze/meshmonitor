import { describe, it, expect } from 'vitest';
import { buildAdminCommandsPath, parseAdminDeepLink } from './adminDeepLink';

describe('buildAdminCommandsPath', () => {
  it('nests the path under /source/:sourceId/admin — the route does not exist at top level', () => {
    expect(buildAdminCommandsPath('src-1')).toBe('/source/src-1/admin');
  });

  it('returns the bare nested admin path when no node is given', () => {
    expect(buildAdminCommandsPath('src-1', {})).toBe('/source/src-1/admin');
  });

  it('includes node (lower-cased)', () => {
    const path = buildAdminCommandsPath('src-1', { node: '!AABBCCDD' });
    const [pathname, query] = path.split('?');
    expect(pathname).toBe('/source/src-1/admin');
    const params = new URLSearchParams(query);
    expect(params.get('node')).toBe('!aabbccdd');
  });

  it('URL-encodes the sourceId segment', () => {
    const path = buildAdminCommandsPath('src one/two');
    expect(path).toBe('/source/src%20one%2Ftwo/admin');
  });
});

describe('parseAdminDeepLink', () => {
  it('returns null when node is missing', () => {
    expect(parseAdminDeepLink(new URLSearchParams(''))).toBeNull();
  });

  it('round-trips a valid node id through build/parse', () => {
    const path = buildAdminCommandsPath('src-1', { node: '!aabbccdd' });
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
