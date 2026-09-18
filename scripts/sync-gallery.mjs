#!/usr/bin/env node
/**
 * Regenerate the server's copy of the User Scripts Gallery listing (#5255).
 *
 * The server needs filename -> repo path to check an installed gallery script
 * for updates. `src/server/data/userScriptsGallery.test.ts` fails when this
 * copy drifts from the docs listing, so run this after editing the gallery.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../docs/.vitepress/data/user-scripts.json', import.meta.url));
const dest = fileURLToPath(new URL('../src/server/data/userScriptsGallery.json', import.meta.url));

const entries = JSON.parse(readFileSync(src, 'utf8')).map((e) => ({
  filename: e.filename,
  name: e.name,
  ...(e.githubPath ? { githubPath: e.githubPath } : {}),
}));

writeFileSync(dest, `${JSON.stringify(entries, null, 2)}\n`);
console.log(`Wrote ${entries.length} gallery entries to ${dest}`);
