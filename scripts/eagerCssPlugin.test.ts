/**
 * Tests for the `meshmonitor-eager-css` plugin in vite.config.ts (#5558).
 *
 * On Windows `path.resolve` returns backslash paths while Vite's module ids
 * use forward slashes. The plugin compared one to the other, never matched,
 * left src/eagerStyles.ts empty, and the Desktop build shipped a landing page
 * with no theme rules. These tests feed the plugin `path.win32` paths so the
 * Windows case runs on any host.
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { eagerCss, isEagerStylesId, toModuleId, type EagerCssOptions } from '../vite.config';

const WIN_ROOT = 'D:\\a\\meshmonitor\\meshmonitor';
const WIN_ENTRY = path.win32.resolve(WIN_ROOT, 'src/main.tsx');
const WIN_EAGER = path.win32.resolve(WIN_ROOT, 'src/eagerStyles.ts');
// What Vite passes to `load` for that same file on Windows.
const VITE_EAGER_ID = 'D:/a/meshmonitor/meshmonitor/src/eagerStyles.ts';
const SRC = 'D:/a/meshmonitor/meshmonitor/src';

type Hook = (this: unknown, ...args: unknown[]) => unknown;

/** A fake plugin context: resolves relative specifiers the way Vite would. */
function makeContext() {
  const importers: string[] = [];
  return {
    importers,
    async resolve(spec: string, importer: string) {
      importers.push(importer);
      if (!spec.startsWith('.')) return { id: `/node_modules/${spec}/index.js`, external: false };
      return { id: path.posix.join(path.posix.dirname(importer), spec), external: false };
    },
    error(message: string): never {
      throw new Error(message);
    },
  };
}

function setup(files: Record<string, string>, overrides: Partial<EagerCssOptions> = {}) {
  const plugin = eagerCss({
    entry: WIN_ENTRY,
    eagerStyles: WIN_EAGER,
    read: async (file) => {
      if (!(file in files)) throw new Error(`ENOENT: ${file}`);
      return files[file];
    },
    ...overrides,
  });
  const ctx = makeContext();
  const call = (hook: 'configResolved' | 'buildStart' | 'load' | 'buildEnd', ...args: unknown[]) =>
    (plugin[hook] as unknown as Hook).call(ctx, ...args);
  call('configResolved', { command: 'build' });
  call('buildStart');
  return { ctx, call };
}

const APP_FILES = {
  [`${SRC}/main.tsx`]: `const App = lazy(() => import('./App.tsx'))\nconst Login = lazy(() => import('./pages/Login.tsx'))\n`,
  [`${SRC}/App.tsx`]: `import React from 'react'\nimport './App.css'\nimport s from './App.module.css'\n`,
  [`${SRC}/pages/Login.tsx`]: `import '../App.css'\nimport './login.css'\n`,
};

describe('toModuleId / isEagerStylesId', () => {
  it('turns a Windows path into the forward-slash form Vite uses', () => {
    expect(WIN_EAGER).toBe('D:\\a\\meshmonitor\\meshmonitor\\src\\eagerStyles.ts');
    expect(toModuleId(WIN_EAGER)).toBe(VITE_EAGER_ID);
  });

  it('leaves a POSIX path alone', () => {
    expect(toModuleId('/home/u/repo/src/eagerStyles.ts')).toBe('/home/u/repo/src/eagerStyles.ts');
  });

  it("matches Vite's forward-slash id against a path.win32.resolve constant", () => {
    expect(isEagerStylesId(VITE_EAGER_ID, WIN_EAGER)).toBe(true);
    expect(isEagerStylesId(`${VITE_EAGER_ID}?v=abc123`, WIN_EAGER)).toBe(true);
  });

  it('does not match another module', () => {
    expect(isEagerStylesId(`${SRC}/main.tsx`, WIN_EAGER)).toBe(false);
  });
});

describe('eagerCss() on Windows-style paths (#5558)', () => {
  it('fills the placeholder when Vite passes a forward-slash id', async () => {
    const { call } = setup(APP_FILES);
    const code = (await call('load', VITE_EAGER_ID)) as string | null;
    // On main this was null: the backslash constant never equalled the id.
    expect(code).not.toBeNull();
    expect(code).toContain(`import "${SRC}/App.css";`);
    expect(code).toContain(`import m1 from "${SRC}/App.module.css";`);
    expect(code).toContain(`import "${SRC}/pages/login.css";`);
    expect(code).toContain('globalThis.__meshmonitorEagerCss = [m1];');
    // Each stylesheet once, in first-seen order.
    expect(code!.match(/App\.css"/g)).toHaveLength(1);
    expect(code!.indexOf('App.css')).toBeLessThan(code!.indexOf('login.css'));
  });

  it('reads the entry and resolves from it with forward-slash paths only', async () => {
    const read: string[] = [];
    const { ctx, call } = setup(APP_FILES, {
      read: async (file) => {
        read.push(file);
        return (APP_FILES as Record<string, string>)[file];
      },
    });
    await call('load', VITE_EAGER_ID);
    expect(read[0]).toBe(`${SRC}/main.tsx`);
    expect([...read, ...ctx.importers].filter((p) => p.includes('\\'))).toEqual([]);
  });

  it('ignores every other module id', async () => {
    const { call } = setup(APP_FILES);
    expect(await call('load', `${SRC}/main.tsx`)).toBeNull();
  });
});

describe('eagerCss() never does nothing quietly (#5558)', () => {
  it('throws from load when the walk finds no stylesheet', async () => {
    const { call } = setup({
      [`${SRC}/main.tsx`]: `const App = lazy(() => import('./App.tsx'))\n`,
      [`${SRC}/App.tsx`]: `import React from 'react'\n`,
    });
    await expect(call('load', VITE_EAGER_ID)).rejects.toThrow(/found no stylesheet/);
  });

  it('throws from load when the entry has no lazy pages', async () => {
    const { call } = setup({ [`${SRC}/main.tsx`]: `import App from './App.tsx'\n` });
    await expect(call('load', VITE_EAGER_ID)).rejects.toThrow(/found no stylesheet/);
  });

  it('throws at buildEnd when the placeholder was never loaded', () => {
    const { call } = setup(APP_FILES);
    expect(() => call('buildEnd')).toThrow(/without loading/);
  });

  it('passes buildEnd once the placeholder was filled', async () => {
    const { call } = setup(APP_FILES);
    await call('load', VITE_EAGER_ID);
    expect(() => call('buildEnd')).not.toThrow();
  });

  it('leaves an earlier build error alone', () => {
    const { call } = setup(APP_FILES);
    expect(() => call('buildEnd', new Error('some other failure'))).not.toThrow();
  });

  it('does not throw for a dev server, which loads modules on demand', () => {
    const { call } = setup(APP_FILES);
    call('configResolved', { command: 'serve' });
    expect(() => call('buildEnd')).not.toThrow();
  });
});
