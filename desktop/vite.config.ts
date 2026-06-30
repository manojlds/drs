import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// DRS Desktop renderer build.
//
// The Electron main process (electron/main.cjs) loads either the Vite dev
// server (http://127.0.0.1:5173) or the built dist-renderer/ bundle. `base` is
// relative so the built index.html works under file:// inside Electron.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
