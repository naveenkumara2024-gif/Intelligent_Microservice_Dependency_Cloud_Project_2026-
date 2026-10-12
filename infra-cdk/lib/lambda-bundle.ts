import * as path from 'node:path';

// Output of `npm run build` in src/lambda-transformer (esbuild; gitignored). It holds index.js
// (the graph transformer) and probe.js (the Stage 9 Neptune verification probe).
export const BUNDLE_DIR = path.join(__dirname, '..', '..', 'src', 'lambda-transformer', 'dist');
