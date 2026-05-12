import js from '@eslint/js';
import { fixupPluginRules } from '@eslint/compat';
import typescript from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

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
    },
    rules: {
      ...js.configs.recommended.rules,
      ...typescript.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-control-regex': 'off',
      'prefer-const': 'warn',
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