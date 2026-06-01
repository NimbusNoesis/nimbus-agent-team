import { defineConfig } from 'tsup';
import { cp, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  async onSuccess() {
    // Ensure output directory exists
    await mkdir('dist/dashboard/public', { recursive: true });

    // Copy static assets
    await cp('src/dashboard/public/index.html', 'dist/dashboard/public/index.html');
    await cp('src/dashboard/public/style.css', 'dist/dashboard/public/style.css');

    // Bundle the Preact client
    await build({
      entryPoints: ['src/dashboard/client/main.tsx'],
      outfile: 'dist/dashboard/public/app.js',
      bundle: true,
      format: 'esm',
      jsx: 'automatic',
      jsxImportSource: 'preact',
      minify: true,
      sourcemap: true,
    });
  },
});
