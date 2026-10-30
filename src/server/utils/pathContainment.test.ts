import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveWithinDir, isWithinDir } from './pathContainment.js';

describe('resolveWithinDir', () => {
  const root = '/data/backups';

  it('accepts a relative child and returns its absolute path', () => {
    expect(resolveWithinDir(root, 'nodeX-2026-01-01.yaml')).toBe(path.resolve(root, 'nodeX-2026-01-01.yaml'));
  });

  it('accepts an absolute path that is inside the root', () => {
    expect(resolveWithinDir(root, '/data/backups/foo.yaml')).toBe('/data/backups/foo.yaml');
  });

  it('accepts the root itself', () => {
    expect(resolveWithinDir(root, '.')).toBe(path.resolve(root));
  });

  it('rejects an absolute path outside the root', () => {
    expect(() => resolveWithinDir(root, '/etc/passwd')).toThrow(/escapes the permitted directory/);
  });

  it('rejects "../" traversal that escapes the root', () => {
    expect(() => resolveWithinDir(root, '../../etc/passwd')).toThrow(/escapes the permitted directory/);
    expect(() => resolveWithinDir(root, '..')).toThrow(/escapes/);
  });

  it('rejects a sibling-prefix directory (no partial-prefix bypass)', () => {
    // /data/backups-evil must NOT be considered inside /data/backups.
    expect(() => resolveWithinDir(root, '/data/backups-evil/x.yaml')).toThrow(/escapes/);
  });

  it('isWithinDir mirrors the throw/accept decision', () => {
    expect(isWithinDir(root, 'ok.yaml')).toBe(true);
    expect(isWithinDir(root, '/etc/passwd')).toBe(false);
  });
});
