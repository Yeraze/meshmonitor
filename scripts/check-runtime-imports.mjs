#!/usr/bin/env node
/**
 * Fail the build if any module reachable from the server entry point contains
 * a relative `import`/`export ... from` specifier that Node's ESM loader
 * cannot resolve.
 *
 * Why this exists
 * ---------------
 * `package.json` sets `"type": "module"`, so the compiled output is ESM, and
 * ESM resolution is exact: a relative specifier must name the file including
 * its extension. There is no extension search and no directory-index fallback.
 * Vite papers over this for the frontend, and TypeScript does not police it,
 * so `import x from '../foo'` compiles cleanly, works in the browser, and
 * throws ERR_MODULE_NOT_FOUND the moment the server loads it.
 *
 * The build currently emits ~90 such specifiers, all in frontend modules that
 * `tsc -p tsconfig.server.json` compiles because they are transitively
 * type-referenced. None are reachable from the server today, so none break
 * anything. The hazard is that they are one ordinary-looking import away from
 * being reachable — a backend file importing, say, `utils/mapIcons` would fail
 * only at runtime, in a packaged desktop build or a container, with no test or
 * type error pointing at it. That is the shape of #4591.
 *
 * This walks the graph the server actually loads and fails CI at the moment
 * such a module becomes reachable, instead of a user finding it.
 *
 * Static analysis only — it never executes the modules, so it is safe to point
 * at `server.js`, which would otherwise open sockets and a database.
 *
 * Limitations, stated plainly:
 *   - Only STATIC specifiers. A fully dynamic `import(someVariable)` is
 *     invisible to it, by construction.
 *   - Bare specifiers (`node:fs`, npm packages) are skipped — those are
 *     `node_modules` resolution, a different problem with different tooling.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_ENTRY = 'dist/server/server.js';

/**
 * Strip comments and template/quoted strings before scanning for specifiers.
 *
 * Load-bearing: `src/db/index.ts` carries a JSDoc block containing
 * `import { createDatabase } from './db/index.js';` as usage documentation. An
 * earlier version of this check matched inside that comment and reported a
 * phantom unresolved import. Anything that scans source text for imports has
 * to do this or it reports on prose.
 */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
    } else if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? n : end;
      out += ' ';
    } else if (c === '`') {
      // Template literal: skip to the unescaped closing backtick. Nested
      // `${}` expressions could contain imports in theory; in emitted output
      // they do not, and skipping whole templates never yields a FALSE
      // failure — only a missed check.
      i++;
      while (i < n && !(src[i] === '`' && src[i - 1] !== '\\')) i++;
      i++;
      out += '``';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const SPEC_RE = /(?:\bfrom\s*|(?:^|[;{}\s])import\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/gm;

function specifiersIn(src) {
  const found = [];
  for (const m of stripNonCode(src).matchAll(SPEC_RE)) found.push(m[1]);
  return found;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function main() {
  const entry = path.resolve(process.argv[2] ?? DEFAULT_ENTRY);
  const root = path.resolve(process.argv[3] ?? path.dirname(path.dirname(entry)));

  if (!isFile(entry)) {
    console.error(`check-runtime-imports: entry not found: ${entry}`);
    console.error('Build first (npm run build:server), or pass an explicit entry path.');
    process.exit(2);
  }

  const visited = new Set();
  const problems = [];

  const walk = (file) => {
    if (visited.has(file)) return;
    visited.add(file);

    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { return; }

    for (const spec of specifiersIn(src)) {
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (isFile(target)) { walk(target); continue; }

      // Distinguish "missing extension" from "target genuinely absent" — the
      // former is the common case and the fix is obvious, so say which it is.
      const near = [`${target}.js`, path.join(target, 'index.js')].find(isFile);
      problems.push({ importer: file, spec, near: near ?? null });
    }
  };

  walk(entry);

  const rel = (p) => path.relative(root, p) || p;
  console.log(`check-runtime-imports: walked ${visited.size} modules from ${rel(entry)}`);

  if (problems.length === 0) {
    console.log('OK — every static relative specifier resolves under Node ESM.');
    return;
  }

  console.error(`\nFAIL — ${problems.length} unresolvable specifier(s) reachable from the server entry point:\n`);
  for (const p of problems) {
    console.error(`  ${rel(p.importer)}`);
    console.error(`      → '${p.spec}'`);
    console.error(p.near
      ? `      ${path.basename(p.near)} exists — the specifier is missing its extension. Write '${p.spec}.js'.`
      : `      target does not exist.`);
    console.error('');
  }
  console.error('Node ESM resolves relative specifiers exactly: the extension is required.');
  console.error('This passes tsc and passes Vite, and fails only at runtime — see #4591.');
  process.exit(1);
}

main();
