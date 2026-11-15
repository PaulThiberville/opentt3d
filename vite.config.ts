import { defineConfig } from 'vitest/config';

// Relative base keeps the build deployable on GitHub Pages project sites,
// in a sub-directory, or from the local file system.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    host: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
