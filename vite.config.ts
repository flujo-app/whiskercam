import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  server: { port: 5183, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5184, strictPort: true, host: '127.0.0.1' },
});
