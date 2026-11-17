import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  server: { port: 5183, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5184, strictPort: true, host: '127.0.0.1' },
});
