import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
  outDir: 'dist',
  // Native / WASM-heavy deps stay external
  external: ['pg', '@electric-sql/pglite', 'drizzle-orm'],
});
