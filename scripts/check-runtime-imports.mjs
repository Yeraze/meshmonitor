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
 * The build emits ~90 such specifiers, all in frontend modules that
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
 * Parsing is delegated to `es-module-lexer` — the same lexer Vite and Rollup
 * use to find imports. A hand-rolled regex over source text cannot be made
 * correct here: it matches inside comments (`src/db/index.ts` documents its
 * own usage with an `import` line in a JSDoc block) and inside ordinary string
 * literals (an error message quoting an import). Both produce phantom
 * failures, which in a required CI check is worse than the bug being guarded
 * against.
 *
 * Static analysis only — it never executes the modules, so it is safe to point
 * at `server.js`, which would otherwise open sockets and a database.
 *
 * Limitation, stated plainly: only STATIC specifiers. `import(someVariable)`
 * is invisible to it by construction — the lexer reports the site but has no
 * literal to resolve, and those are skipped.
 *
 * Package classification (#5692)
 * ------------------------------
 * The Docker images install only `dependencies` and `optionalDependencies`
 * (`npm prune --omit=dev` / `npm install --omit=dev`). A package the server
 * loads but that sits in `devDependencies` resolves fine in dev, in CI and in
 * the test suite — all of which have the full tree — and throws
 * ERR_MODULE_NOT_FOUND only in a shipped image. So every bare specifier on the
 * reachable graph (ESM `import`, plus `require('x')` through `createRequire`)
 * must name a package listed in `dependencies` or `optionalDependencies`.
 * `require()` is found by a literal-string match, not by the lexer; a phantom
 * match inside a comment can only produce a false failure, never hide a real one.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { builtinModules } from 'node:module';
import { init, parse } from 'es-module-lexer';

const DEFAULT_ENTRY = 'dist/server/server.js';
// Floor for the default entry's reachable graph — see the guard in main().
const MIN_EXPECTED_MODULES = 50;

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * The resolved specifier string of one lexer record. es-module-lexer 3 renamed
 * the field from `n` to `specifier`; reading only `n` turned this whole check
 * into a silent no-op ("walked 1 modules ... OK") after the 3.0 bump. Accept
 * both, and see the minimum-walk guard in main().
 */
function specifierOf(record) {
  return record.specifier ?? record.n;
}

/** Relative specifiers this module imports, re-exports, or dynamically imports. */
function relativeSpecifiers(src) {
  const [imports] = parse(src);
  return imports
    // The specifier is absent for a dynamic import whose argument is not a
    // string literal — nothing to resolve, so nothing to check.
    .map(specifierOf)
    .filter((n) => typeof n === 'string' && n.startsWith('.'));
}

/** Bare (package) specifiers: ESM imports plus literal `require('x')` calls. */
function bareSpecifiers(src) {
  const [imports] = parse(src);
  const out = imports
    .map(specifierOf)
    .filter((n) => typeof n === 'string' && !n.startsWith('.') && !n.startsWith('/'));
  for (const m of src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!m[1].startsWith('.') && !m[1].startsWith('/')) out.push(m[1]);
  }
  return out;
}

const BUILTINS = new Set(builtinModules);

/** `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub` -> `pkg`; null for builtins. */
function packageName(spec) {
  if (spec.startsWith('node:') || BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0])) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

async function main() {
  await init;

  const pkgJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const runtimeDeps = new Set([
    ...Object.keys(pkgJson.dependencies ?? {}),
    ...Object.keys(pkgJson.optionalDependencies ?? {}),
  ]);
  const devDeps = new Set(Object.keys(pkgJson.devDependencies ?? {}));
  /** package -> first importer that pulled it in, for packages the image will not ship. */
  const undeclared = new Map();

  const entry = path.resolve(process.argv[2] ?? DEFAULT_ENTRY);
  if (!isFile(entry)) {
    console.error(`check-runtime-imports: entry not found: ${entry}`);
    console.error('Build first (npm run build:server), or pass an explicit entry path.');
    process.exit(2);
  }

  // Report paths relative to the build root when the entry sits under one
  // (dist/server/server.js -> dist/), else relative to cwd. Either way the
  // output stays readable rather than dumping absolute paths.
  const guessedRoot = path.dirname(path.dirname(entry));
  const root = process.argv[3]
    ? path.resolve(process.argv[3])
    : (entry.startsWith(guessedRoot + path.sep) ? guessedRoot : process.cwd());

  const visited = new Set();
  const problems = [];

  const walk = (file) => {
    if (visited.has(file)) return;
    visited.add(file);

    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { return; }

    let specs;
    try {
      specs = relativeSpecifiers(src);
    } catch (err) {
      // A parse failure is itself worth surfacing — it means we cannot vouch
      // for this file, and silently skipping would make the check a no-op.
      problems.push({ importer: file, spec: null, parseError: String(err?.message ?? err) });
      return;
    }

    for (const spec of bareSpecifiers(src)) {
      const name = packageName(spec);
      if (name && !runtimeDeps.has(name) && !undeclared.has(name)) {
        undeclared.set(name, { importer: file, spec });
      }
    }

    for (const spec of specs) {
      const target = path.resolve(path.dirname(file), spec);
      if (isFile(target)) { walk(target); continue; }

      // Distinguish "missing extension" from "target genuinely absent" — the
      // former is the common case and the fix is mechanical, so say which.
      const near = [`${target}.js`, path.join(target, 'index.js')].find(isFile);
      problems.push({ importer: file, spec, near: near ?? null });
    }
  };

  walk(entry);

  const rel = (p) => path.relative(root, p) || p;
  console.log(`check-runtime-imports: walked ${visited.size} modules from ${rel(entry)}`);

  // The server graph is hundreds of modules. A walk that stops almost at the
  // entry means the lexer stopped reporting specifiers (an API change, as with
  // es-module-lexer 3), not that the server shrank — fail rather than pass.
  if (visited.size < MIN_EXPECTED_MODULES && !process.argv[2]) {
    console.error(`check-runtime-imports: walked only ${visited.size} module(s) from the server entry;`);
    console.error(`expected at least ${MIN_EXPECTED_MODULES}. The import lexer is probably not returning specifiers.`);
    process.exit(2);
  }

  if (undeclared.size > 0) {
    console.error(`\nFAIL — ${undeclared.size} package(s) loaded by the server are not runtime dependencies:\n`);
    for (const [name, { importer, spec }] of undeclared) {
      const where = devDeps.has(name) ? 'listed in devDependencies' : 'not listed in package.json at all';
      console.error(`  ${name} (${where})`);
      console.error(`      first imported by ${rel(importer)} as '${spec}'`);
    }
    console.error('\nThe Docker images install dependencies + optionalDependencies only (--omit=dev),');
    console.error('so these resolve in dev and CI and throw ERR_MODULE_NOT_FOUND in a shipped image.');
    console.error('Move each one to "dependencies" in package.json — see #5692.');
  }

  if (problems.length === 0) {
    if (undeclared.size > 0) process.exit(1);
    console.log('OK — every static relative specifier resolves under Node ESM,');
    console.log('     and every package the server loads is a runtime dependency.');
    return;
  }

  console.error(`\nFAIL — ${problems.length} problem(s) reachable from the server entry point:\n`);
  for (const p of problems) {
    console.error(`  ${rel(p.importer)}`);
    if (p.parseError) {
      console.error(`      could not be parsed: ${p.parseError}`);
    } else {
      console.error(`      → '${p.spec}'`);
      console.error(p.near
        ? `      ${path.basename(p.near)} exists — the specifier is missing its extension. Write '${p.spec}.js'.`
        : `      target does not exist.`);
    }
    console.error('');
  }
  console.error('Node ESM resolves relative specifiers exactly: the extension is required.');
  console.error('This passes tsc and passes Vite, and fails only at runtime — see #4591.');
  process.exit(1);
}

main().catch((err) => {
  console.error('check-runtime-imports: unexpected failure');
  console.error(err);
  process.exit(2);
});
