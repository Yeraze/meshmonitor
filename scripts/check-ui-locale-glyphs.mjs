#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { containsHardcodedUiGlyph } from './eslint-rules/no-hardcoded-ui-glyph.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCALES = path.join(ROOT, 'public', 'locales');

function visit(value, keyPath, failures, file) {
  if (typeof value === 'string') {
    if (containsHardcodedUiGlyph(value)) failures.push(`${file}:${keyPath}`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    visit(child, keyPath ? `${keyPath}.${key}` : key, failures, file);
  }
}

const failures = [];
for (const file of readdirSync(LOCALES).filter(name => name.endsWith('.json')).sort()) {
  const parsed = JSON.parse(readFileSync(path.join(LOCALES, file), 'utf8'));
  visit(parsed, '', failures, file);
}

if (failures.length) {
  console.error('Hardcoded UI glyphs found in locale strings. Render a UiIcon beside translated text instead:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log('Locale UI glyph scan passed.');
