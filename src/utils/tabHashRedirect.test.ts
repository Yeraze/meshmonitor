import { describe, it, expect } from 'vitest';
import { getHashTabRedirectTarget } from './tabHashRedirect';
import { VALID_TABS } from '../types/ui';

describe('getHashTabRedirectTarget', () => {
  it('redirects every VALID_TABS hash on a bare source path (with trailing slash)', () => {
    for (const tab of VALID_TABS) {
      expect(getHashTabRedirectTarget('/source/abc123/', `#${tab}`)).toBe(`/source/abc123/${tab}`);
    }
  });

  it('redirects every VALID_TABS hash on a bare source path (no trailing slash)', () => {
    for (const tab of VALID_TABS) {
      expect(getHashTabRedirectTarget('/source/abc123', `#${tab}`)).toBe(`/source/abc123/${tab}`);
    }
  });

  it('accepts a hash value without the leading #', () => {
    expect(getHashTabRedirectTarget('/source/abc123', 'messages')).toBe('/source/abc123/messages');
  });

  it('enumerated embed/deep-link refs (#3962 5.4 PR1 census): DashboardPage/NodeMarkersLayer "seen by" jump', () => {
    expect(getHashTabRedirectTarget('/source/abc123/', '#messages')).toBe('/source/abc123/messages');
  });

  it('enumerated embed/deep-link refs: DashboardPage MQTT bridge "Configuration" button', () => {
    expect(getHashTabRedirectTarget('/source/abc123/', '#mqtt-config')).toBe('/source/abc123/mqtt-config');
  });

  it('returns null for an empty hash', () => {
    expect(getHashTabRedirectTarget('/source/abc123', '')).toBeNull();
    expect(getHashTabRedirectTarget('/source/abc123', '#')).toBeNull();
  });

  it('returns null for an unrecognized hash value', () => {
    expect(getHashTabRedirectTarget('/source/abc123', '#not-a-tab')).toBeNull();
  });

  it('returns null for the removed "themes" orphan hash', () => {
    expect(getHashTabRedirectTarget('/source/abc123', '#themes')).toBeNull();
  });

  it('returns null once the path already has a tab segment (already migrated)', () => {
    expect(getHashTabRedirectTarget('/source/abc123/nodes', '#messages')).toBeNull();
  });

  it('returns null for paths outside the source view', () => {
    expect(getHashTabRedirectTarget('/', '#nodes')).toBeNull();
    expect(getHashTabRedirectTarget('/unified/messages', '#nodes')).toBeNull();
  });

  it('returns null for a nested/non-bare source path with extra segments', () => {
    expect(getHashTabRedirectTarget('/source/abc123/foo/bar', '#nodes')).toBeNull();
  });
});
