/**
 * The server carries a copy of the User Scripts Gallery listing so an update
 * check can place a script the admin installed from the gallery, without a
 * network call just to learn where it came from (#5255).
 *
 * A copy goes stale, so this test is the drift guard: add a gallery entry and
 * this fails until the server copy is regenerated with
 * `npm run scripts:gallery`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import bundled from './userScriptsGallery.json' with { type: 'json' };

interface GalleryEntry {
  filename: string;
  name: string;
  githubPath?: string;
}

const docsEntries = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../docs/.vitepress/data/user-scripts.json', import.meta.url)), 'utf8')
) as GalleryEntry[];

describe('bundled user scripts gallery (#5255)', () => {
  it('matches the gallery listing the docs site publishes', () => {
    const expected = docsEntries.map(e => ({
      filename: e.filename,
      name: e.name,
      ...(e.githubPath ? { githubPath: e.githubPath } : {}),
    }));
    expect(bundled).toEqual(expected);
  });

  it('carries a path for the entries an update check can follow', () => {
    const withPath = (bundled as GalleryEntry[]).filter(e => e.githubPath);
    expect(withPath.length).toBeGreaterThan(0);
    // Gist-hosted entries have no repo path; they simply are not checkable.
    expect(withPath.every(e => e.githubPath!.split('/').length >= 2)).toBe(true);
  });
});
