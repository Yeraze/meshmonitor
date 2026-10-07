/**
 * No two files under src/ may have names that differ only by letter case.
 *
 * Linux keeps `NumberInputScope.tsx` and `numberInputScope.ts` apart. macOS
 * and Windows do not: there TypeScript resolves both imports to one file and
 * the build fails with TS1149 / TS2724. Only the Desktop CI job builds on
 * those systems, and it runs only for pull requests that touch `desktop/`, so
 * a collision merged to main breaks the next desktop build, not the PR that
 * caused it. (That pair shipped in #5652 and was found this way.)
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, parse, relative } from 'node:path';

const SRC = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

describe('file names under src/', () => {
  it('no two differ only by letter case (extension aside)', () => {
    const byKey = new Map<string, string[]>();
    for (const file of walk(SRC)) {
      const { dir, name } = parse(relative(SRC, file));
      // `Foo.test.tsx` next to `Foo.tsx` is fine: compare the whole stem.
      const key = join(dir, name).toLowerCase();
      const exact = join(dir, name);
      const seen = byKey.get(key) ?? [];
      if (!seen.includes(exact)) seen.push(exact);
      byKey.set(key, seen);
    }
    const collisions = [...byKey.values()].filter(names => names.length > 1);
    expect(collisions).toEqual([]);
  });
});
