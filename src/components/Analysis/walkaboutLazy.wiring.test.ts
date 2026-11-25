/**
 * Source scan (#5891 P2, spec §4.2): `h3-js` must stay in the lazy hex-map
 * chunk on the client. Only WalkaboutHexMap.tsx imports it (outside src/server),
 * and only walkaboutHexMapLazy.ts imports WalkaboutHexMap.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(SRC, p).split(path.sep).join('/');
const files = walk(SRC).filter((p) => !rel(p).startsWith('server/'));
const isTest = (r: string) => /\.test\.tsx?$/.test(r);
const importing = (re: RegExp) =>
  files.filter((p) => re.test(readFileSync(p, 'utf8'))).map(rel).filter((r) => !isTest(r));

describe('walkabout lazy wiring', () => {
  it("only WalkaboutHexMap.tsx imports 'h3-js' on the client", () => {
    expect(importing(/from\s+['"]h3-js['"]|import\(\s*['"]h3-js['"]/)).toEqual([
      'components/Analysis/WalkaboutHexMap.tsx',
    ]);
  });

  it('src/utils/walkabout.ts does not import h3-js', () => {
    expect(readFileSync(path.join(SRC, 'utils/walkabout.ts'), 'utf8')).not.toMatch(/from\s+['"]h3-js['"]/);
  });

  it('WalkaboutHexMap is imported only by walkaboutHexMapLazy.ts, lazily', () => {
    expect(importing(/['"][^'"]*\/WalkaboutHexMap(\.js)?['"]|['"]\.\/WalkaboutHexMap(\.js)?['"]/)).toEqual([
      'components/Analysis/walkaboutHexMapLazy.ts',
    ]);
    const lazy = readFileSync(path.join(SRC, 'components/Analysis/walkaboutHexMapLazy.ts'), 'utf8');
    expect(lazy).toMatch(/lazyWithPreload\(\(\) => import\('\.\/WalkaboutHexMap'\)\)/);
  });
});
