import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node', // Default to node, tests can override with @vitest-environment
    setupFiles: './src/test/setup.ts',
    isolate: true,
    testTimeout: 10000,
    hookTimeout: 10000,
    // Run tests serially to avoid OOM issues
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.paperclip/**',
    ],
    env: {
      DATABASE_PATH: ':memory:',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/test/',
        '*.config.ts',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.test.tsx'
      ],
      thresholds: {
        statements: 32,
        'src/utils/**': {
          statements: 70,
        },
        'src/server/**': {
          statements: 25,
        },
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Force the ESM build of the spiderfier under Vitest. Its package `main`
      // is a UMD bundle whose named `OverlappingMarkerSpiderfier` export isn't a
      // constructor when Vitest externalizes it, so any test that mounts a
      // spiderfier-using map component (e.g. MeshCoreSourcePage → MeshCoreMap)
      // throws "OverlappingMarkerSpiderfier is not a constructor". The `module`
      // (ESM) entry exports the real class. App build (vite.config) is unaffected.
      'ts-overlapping-marker-spiderfier-leaflet': path.resolve(
        __dirname,
        'node_modules/ts-overlapping-marker-spiderfier-leaflet/dist/omsleaflet.js',
      ),
    }
  }
});