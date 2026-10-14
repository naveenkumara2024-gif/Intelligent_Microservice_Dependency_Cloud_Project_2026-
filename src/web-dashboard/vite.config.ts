import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The SPA calls relative /api/... URLs. In production CloudFront routes /api/* to API Gateway on
// the same origin and adds the origin header. Locally, /api goes to:
//   - the deployed API, when RCA_API_URL and RCA_ORIGIN_SECRET are set (infra-cdk:
//     `npm run dashboard:local` sets both; the secret stays in this process, never in the bundle);
//   - otherwise the mock (`npm run mock`, http://127.0.0.1:8787).
const liveApi = process.env.RCA_API_URL;
const secret = process.env.RCA_ORIGIN_SECRET;
if (liveApi && !secret) throw new Error('RCA_API_URL is set but RCA_ORIGIN_SECRET is not; the API would answer 403');

const apiProxy = liveApi
  ? { '/api': { target: liveApi, changeOrigin: true, secure: true, headers: { 'x-rca-origin': secret! } } }
  : { '/api': 'http://127.0.0.1:8787' };

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', proxy: apiProxy },
  preview: { host: '127.0.0.1', proxy: apiProxy },
  build: { outDir: 'dist', sourcemap: false },
  test: { environment: 'node', include: ['test/**/*.test.ts', 'test/**/*.test.tsx'] },
});
