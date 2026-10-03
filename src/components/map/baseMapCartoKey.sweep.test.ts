/**
 * Sweep (#5555): every `<BaseMap>` that is handed the user's tileset must also
 * be handed the CARTO API key. The Traceroute Explorer and Coverage Report
 * maps passed `tilesetId={mapTileset}` without `cartoApiKey`, so CARTO
 * presets drew "API key required" watermark tiles there while the main map
 * was clean. Either spread `useBaseMapSettings()` or pass `cartoApiKey`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') && !/\.test\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

/** Opening `<BaseMap …>` tags, read up to the `>` that sits outside braces. */
function baseMapTags(source: string): string[] {
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('<BaseMap', from);
    if (start < 0) return tags;
    let depth = 0;
    let i = start + '<BaseMap'.length;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    tags.push(source.slice(start, i + 1));
    from = i + 1;
  }
}

const files = walk(SRC)
  .map((path) => ({ path: relative(SRC, path), source: readFileSync(path, 'utf8') }))
  .filter((f) => f.source.includes('<BaseMap'));

describe('BaseMap CARTO key sweep (#5555)', () => {
  it('finds the BaseMap consumers (guards against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files.map((f) => [f.path, f.source] as const))(
    '%s passes cartoApiKey wherever it passes a tileset',
    (_path, source) => {
      const spreadNames = [...source.matchAll(/const\s+(\w+)\s*=\s*useBaseMapSettings\(\)/g)].map((m) => m[1]);
      for (const tag of baseMapTags(source)) {
        const spreadsSettings = spreadNames.some((name) => tag.includes(`{...${name}}`));
        if (!/\btilesetId=/.test(tag) && !spreadsSettings) continue;
        expect(spreadsSettings || /\bcartoApiKey=/.test(tag), tag).toBe(true);
      }
    },
  );

  it('the two maps from the bug report use the shared hook', () => {
    for (const path of ['components/Analysis/CoverageMap.tsx', 'components/Analysis/tracerouteExplorer/ExplorerMap.tsx']) {
      const file = files.find((f) => f.path === path);
      expect(file, path).toBeDefined();
      expect(file!.source).toMatch(/\{\.\.\.baseMapSettings\}/);
    }
  });
});
