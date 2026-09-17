import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseMmMetaVersion, cleanVersion, resolveScriptVersion } from './scriptVersion';

describe('parseMmMetaVersion (#5255)', () => {
  it('reads the version from a Python mm_meta block', () => {
    const code = '#!/usr/bin/env python3\n# mm_meta:\n#   name: Weather\n#   version: 3.1.0\n"""doc"""\n';
    expect(parseMmMetaVersion(code)).toBe('3.1.0');
  });

  it('reads the version from a JavaScript mm_meta block', () => {
    const code = '#!/usr/bin/env node\n// mm_meta:\n//   name: Hello\n//   version: v1.2\n';
    expect(parseMmMetaVersion(code)).toBe('1.2');
  });

  it('returns null without a block or a version field', () => {
    expect(parseMmMetaVersion('print("hi")\n# version: 1.0\n')).toBeNull();
    expect(parseMmMetaVersion('# mm_meta:\n#   name: No Version\n')).toBeNull();
    expect(parseMmMetaVersion('')).toBeNull();
  });
});

describe('cleanVersion (#5255)', () => {
  it('accepts plain version tokens', () => {
    expect(cleanVersion('2.0.0-beta.1')).toBe('2.0.0-beta.1');
    expect(cleanVersion(' 1.4 ')).toBe('1.4');
  });

  it('rejects markup, spaces, blanks, oversized and non-string values', () => {
    expect(cleanVersion('<b>1</b>')).toBeNull();
    expect(cleanVersion('1.0 final')).toBeNull();
    expect(cleanVersion('   ')).toBeNull();
    expect(cleanVersion('1'.repeat(21))).toBeNull();
    expect(cleanVersion(3)).toBeNull();
  });
});

describe('resolveScriptVersion (#5255)', () => {
  it("prefers the author's mm_meta over the gallery JSON", () => {
    const code = '# mm_meta:\n#   version: 3.1\n';
    expect(resolveScriptVersion({ version: '3.0' }, code)).toEqual({ version: '3.1', source: 'script' });
  });

  it('falls back to the gallery JSON version', () => {
    expect(resolveScriptVersion({ version: '3.0' }, 'no meta')).toEqual({ version: '3.0', source: 'gallery' });
    expect(resolveScriptVersion({ version: '3.0' })).toEqual({ version: '3.0', source: 'gallery' });
  });

  it('returns null when neither declares one', () => {
    expect(resolveScriptVersion({}, null)).toBeNull();
  });
});

describe('user-scripts.json version fields (#5255)', () => {
  it('only carries valid optional versions', () => {
    const path = fileURLToPath(new URL('../data/user-scripts.json', import.meta.url));
    const entries = JSON.parse(readFileSync(path, 'utf8')) as Array<{ name: string; version?: unknown }>;
    const bad = entries.filter(e => e.version !== undefined && cleanVersion(e.version) === null).map(e => e.name);
    expect(bad).toEqual([]);
  });
});
