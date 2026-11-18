import { defineConfig } from 'vitest/config';

// only this checkout's own tests (work trees of the same repository live under build/)
export default defineConfig({ test: { exclude: ['build/**', 'node_modules/**', 'dist/**'] } });
