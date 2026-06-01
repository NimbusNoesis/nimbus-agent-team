import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  test: {
    environmentMatchGlobs: [
      ['tests/dashboard-*.test.tsx', 'jsdom'],
    ],
  },
});
