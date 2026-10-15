/**
 * Every `channels_config.*` and `meshcore.channels.*` key the UI asks for must
 * exist in public/locales/en.json (#5826). About 40 were missing: other
 * locales could not translate them, and `channels_config.toast_channel_deleted`
 * had no inline default, so its toast showed the raw key.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');
const en = JSON.parse(readFileSync(join(srcRoot, '../public/locales/en.json'), 'utf8')) as Record<string, string>;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const KEY_RE = /\bt\(\s*(['"`])((?:channels_config|meshcore\.channels)\.[A-Za-z0-9_.]+)\1/g;

describe('channel i18n keys (#5826)', () => {
  const used = new Map<string, string>();
  for (const file of [...sourceFiles(join(srcRoot, 'components')), ...sourceFiles(join(srcRoot, 'pages'))]) {
    for (const m of readFileSync(file, 'utf8').matchAll(KEY_RE)) {
      if (!used.has(m[2])) used.set(m[2], relative(srcRoot, file));
    }
  }

  it('finds the keys it checks', () => {
    // Guards the scan itself: a broken regex would pass the next test vacuously.
    expect(used.has('channels_config.toast_channel_deleted')).toBe(true);
    expect(used.has('meshcore.channels.confirm_reset_public')).toBe(true);
  });

  it('every key used in code is in en.json', () => {
    const missing = [...used].filter(([key]) => !(key in en)).map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });

  it('the delete toast has text and fills in the slot', () => {
    expect(en['channels_config.toast_channel_deleted']).toContain('{{slot}}');
    expect(en['channels_config.confirm_delete']).toContain('{{slot}}');
  });
});
