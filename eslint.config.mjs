import js from '@eslint/js';
import { fixupPluginRules } from '@eslint/compat';
import typescript from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import { noHardcodedUiGlyph } from './scripts/eslint-rules/no-hardcoded-ui-glyph.mjs';

export default [
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '*.config.js',
      '*.config.ts',
      'eslint.config.mjs',
      '.eslintrc.cjs',
      'docs/**',      // VitePress site is its own project; .vitepress/cache is build output
      'examples/**',
      'protobufs/**', // git submodule — vendored
      'public/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    languageOptions: {
      parser: typescriptParser,
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2020,
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
      'react-hooks': fixupPluginRules(reactHooks),
      'react-refresh': reactRefresh,
      'meshmonitor-ui': {
        rules: {
          'no-hardcoded-ui-glyph': noHardcodedUiGlyph,
        },
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...typescript.configs.recommended.rules,
      // TypeScript's own compiler reports undefined identifiers; the core rule only
      // produces false positives on ambient/type globals (NodeJS, React, vi, RequestInfo).
      // This is the standard typescript-eslint recommendation.
      'no-undef': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',          // was 'warn' — new violations blocked; existing baselined
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      '@typescript-eslint/no-explicit-any': 'error',   // was 'warn' — new any blocked; existing baselined
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-control-regex': 'off',
      'prefer-const': 'error',                          // was 'warn' — auto-fixed in WP2
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.property.name='db'][callee.property.name='prepare']",
          message: "Raw SQL forbidden outside src/server/migrations/. Use Drizzle repository in src/db/repositories/. For intentional raw (bootstrap/diagnostic), add eslint-disable-next-line with reason.",
        },
        {
          selector: "CallExpression[callee.object.property.name='db'][callee.property.name='exec']",
          message: "Raw SQL forbidden outside src/server/migrations/. Use Drizzle repository in src/db/repositories/. For intentional raw (bootstrap/diagnostic), add eslint-disable-next-line with reason.",
        },
        {
          // Catches `const db = databaseService.db; db.prepare(...)` — the
          // local-variable escape hatch around the two selectors above.
          selector: "CallExpression[callee.object.name='db'][callee.property.name='prepare']",
          message: "Raw SQL forbidden outside src/server/migrations/. Use Drizzle repository in src/db/repositories/. For intentional raw (bootstrap/diagnostic), add eslint-disable-next-line with reason.",
        },
        {
          selector: "CallExpression[callee.object.name='db'][callee.property.name='exec']",
          message: "Raw SQL forbidden outside src/server/migrations/. Use Drizzle repository in src/db/repositories/. For intentional raw (bootstrap/diagnostic), add eslint-disable-next-line with reason.",
        },
        {
          selector: "CallExpression[callee.object.property.name='postgresPool'][callee.property.name='query']",
          message: "Raw SQL forbidden outside src/server/migrations/. Use Drizzle repository in src/db/repositories/. For intentional raw (bootstrap/diagnostic), add eslint-disable-next-line with reason.",
        },
        {
          selector: "CallExpression[callee.object.property.name='mysqlPool'][callee.property.name='query']",
          message: "Raw SQL forbidden outside src/server/migrations/. Use Drizzle repository in src/db/repositories/. For intentional raw (bootstrap/diagnostic), add eslint-disable-next-line with reason.",
        },
      ],
    },
  },
  {
    // Migrations are allowed to use raw SQL — they predate the schema/repos.
    // Test files are allowed to use raw SQL for fixture setup/verification.
    files: [
      'src/server/migrations/**',
      'src/db/migrations.ts',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Standalone Node utility scripts and test helpers live outside tsconfig.json;
    // parse them without the type-aware project service so parser errors don't fire.
    files: [
      'scripts/**/*.{js,mjs,cjs,ts}',
      '*.{js,mjs,cjs}',
      'tests/**/*.{js,mjs,cjs}',
    ],
    languageOptions: { parserOptions: { project: false } },
  },
  {
    // Phase 1.4 ratchet: components/pages must not call the network directly.
    // Use ApiService (src/services/api.ts) or a TanStack query hook. Existing
    // violations are frozen by the lint ratchet; they migrate in remediation Phase 5.
    // NOTE: this block REPLACES no-restricted-syntax for components/pages (flat-config
    // semantics). The SQL-ban selectors are not needed here — components/pages never
    // touch the DB directly.
    files: ['src/components/**', 'src/pages/**'],
    ignores: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      'src/components/icons/**',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='fetch']",
          message: "Raw fetch() is banned in components/pages. Use ApiService (src/services/api.ts) or a TanStack query hook. See remediation Phase 5.",
        },
        {
          selector: "CallExpression[callee.object.name='window'][callee.property.name='fetch']",
          message: "Raw window.fetch() is banned in components/pages. Use ApiService or a query hook.",
        },
        {
          selector: "CallExpression[callee.object.name='globalThis'][callee.property.name='fetch']",
          message: "Raw globalThis.fetch() is banned in components/pages. Use ApiService or a query hook.",
        },
      ],
    },
  },
  {
    // #4215: app-owned interface icons must come from the typed UiIcon registry.
    // These narrow exceptions contain user-selected or on-mesh protocol content.
    files: ['src/components/**', 'src/pages/**'],
    ignores: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      'src/components/icons/**',
      'src/components/EmojiPickerModal/**',
      'src/components/WaypointEditorModal.tsx',
      'src/components/map/layers/WaypointsLayer.tsx',
      'src/components/AutoAcknowledgeSection.tsx',
      'src/components/AutoWelcomeSection.tsx',
      'src/components/MeshCore/MeshCoreAutoAckSection.tsx',
      'src/components/meshtasticAutomationTokens.ts',
      'src/components/automations/catalog.ts',
      'src/components/automations/AutomationsPage.tsx',
    ],
    rules: {
      'meshmonitor-ui/no-hardcoded-ui-glyph': 'error',
    },
  },
  {
    // Type-aware: no un-awaited promises in production code.
    // Scoped to src non-test TS/TSX only (test files have project:false and
    // would crash a type-aware rule). See eslint.config.mjs test override below.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  // Test files are excluded from tsconfig.json, so disable project-based type-checking for them
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
    languageOptions: {
      parserOptions: {
        project: false,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
