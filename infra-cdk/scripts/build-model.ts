// Builds src/ml-engine/dist/model.tar.gz (the SageMaker model artifact) with whatever Python can
// run it. Used by `npm run build:model` / `deploy:sagemaker` instead of a bare `python`, which on
// Windows may resolve to the Microsoft Store stub. Exits non-zero if the build is refused (for
// example, weights without a passing Boutique gate evaluation).
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { findPython, NO_PYTHON_MESSAGE } from './python';

const script = path.resolve(__dirname, '..', '..', 'src', 'ml-engine', 'build_artifact.py');
const python = findPython();
if (!python) {
  console.error(`FAIL  ${NO_PYTHON_MESSAGE}`);
  process.exit(1);
}
console.log(`Using Python: ${python.executable ?? python.cmd}`);

const result = spawnSync(python.cmd, [...python.args, script, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: path.dirname(script),
});
process.exit(result.status ?? 1);
