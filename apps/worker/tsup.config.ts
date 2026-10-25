import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  clean: true,
  sourcemap: true,
  target: 'node18',
  outDir: 'dist',
  external: ['@stora-sh/db', '@stora-sh/runtime'],
});
