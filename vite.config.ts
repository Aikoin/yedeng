import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

export default defineConfig({
  root: resolve(root, 'src'),
  publicDir: resolve(root, 'public'),
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'chrome114',
    sourcemap: false,
    minify: false,
    rollupOptions: {
      input: {
        welcome: resolve(root, 'src/welcome/index.html'),
        health: resolve(root, 'src/health/index.html'),
        preflight: resolve(root, 'src/preflight/index.html'),
        viewer: resolve(root, 'src/viewer/index.html'),
        options: resolve(root, 'src/options/index.html'),
        popup: resolve(root, 'src/popup/index.html'),
        library: resolve(root, 'src/library/index.html'),
        background: resolve(root, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    root: resolve(root),
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
