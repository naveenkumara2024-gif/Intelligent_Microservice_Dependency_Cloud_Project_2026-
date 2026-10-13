import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The SPA calls relative /api/... URLs: in production CloudFront routes /api/* to API Gateway on
// the same origin; in development this proxy points them at the local mock (npm run mock).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  preview: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { outDir: 'dist', sourcemap: false },
  test: { environment: 'node', include: ['test/**/*.test.ts', 'test/**/*.test.tsx'] },
});
