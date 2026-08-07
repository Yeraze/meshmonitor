import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester } from 'eslint';
import {
  isExtensionlessRelativeSpecifier,
  requireRelativeImportExtension,
} from './require-relative-import-extension.mjs';

test('flags extensionless relative specifiers', () => {
  // The three specifiers named in issue #4596, plus the intra-directory form.
  for (const value of [
    '../components/map/markerIcons',
    '../components/map/popups/nodeCardModel',
    '../components/EmojiPickerModal/EmojiPickerModal',
    './tracerouteSegments',
    '../types/device',
  ]) {
    assert.equal(isExtensionlessRelativeSpecifier(value), true, value);
  }
});

test('allows specifiers that already carry an extension', () => {
  for (const value of [
    './nodeHelpers.js',
    '../services/api.js',
    './schema.json',
    './Component.module.css',
    '../assets/icon.svg',
  ]) {
    assert.equal(isExtensionlessRelativeSpecifier(value), false, value);
  }
});

test('ignores bare package specifiers — Node resolves those via node_modules', () => {
  for (const value of ['react', 'leaflet', 'node:fs', '@tanstack/react-query', 'better-sqlite3']) {
    assert.equal(isExtensionlessRelativeSpecifier(value), false, value);
  }
});

test('rule reports import, export-from, and dynamic import alike', () => {
  const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
  });

  ruleTester.run('require-relative-import-extension', requireRelativeImportExtension, {
    valid: [
      "import { a } from './a.js';",
      "export * from '../b/c.js';",
      "const m = await import('./d.js');",
      "import React from 'react';",
      "import './styles.css';",
    ],
    invalid: [
      { code: "import { a } from './a';", errors: [{ messageId: 'missingExtension' }] },
      { code: "export * from '../b/c';", errors: [{ messageId: 'missingExtension' }] },
      { code: "export { d } from './d';", errors: [{ messageId: 'missingExtension' }] },
      { code: "const m = await import('./e');", errors: [{ messageId: 'missingExtension' }] },
    ],
  });
});
