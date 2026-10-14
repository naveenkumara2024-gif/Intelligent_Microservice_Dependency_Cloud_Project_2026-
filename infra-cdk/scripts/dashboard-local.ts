// Serves the dashboard on this machine against the DEPLOYED API (ApiStack), without CloudFront.
//
//   npm run dashboard:local           -> http://127.0.0.1:5173
//
// It reads ApiStack's outputs, fetches the origin-header secret from Secrets Manager (the value is
// passed to the Vite dev server's proxy through its environment and never printed or written to
// disk), and starts `npm run dev` in src/web-dashboard. Local only: the dev server binds 127.0.0.1.
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { aws, awsJson } from './aws-cli';

const stack = awsJson<{ Stacks: { Outputs?: { OutputKey: string; OutputValue: string }[] }[] }>([
  'cloudformation', 'describe-stacks', '--stack-name', 'ApiStack',
]);
const out = Object.fromEntries((stack.value?.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
if (!out.ApiEndpoint || !out.OriginSecretArn) {
  console.error('ApiStack is not deployed (no ApiEndpoint/OriginSecretArn output): run npm run deploy:api first');
  process.exit(1);
}

const secret = aws(['secretsmanager', 'get-secret-value', '--secret-id', out.OriginSecretArn, '--query', 'SecretString', '--output', 'text']);
// aws() appends --output json after our args; the last --output wins in the AWS CLI, so parse JSON.
let value: string | undefined;
try {
  value = JSON.parse(secret.stdout) as string;
} catch {
  value = secret.stdout.trim() || undefined;
}
if (!secret.ok || !value) {
  console.error(`could not read the origin secret: ${secret.stderr || 'empty value'}`);
  process.exit(1);
}

console.log(`API: ${out.ApiEndpoint} (topology backend: ${out.TopologyBackend ?? 'unknown'})`);
console.log('Starting the dashboard on http://127.0.0.1:5173 (Ctrl-C to stop)...');
const dashboard = path.join(__dirname, '..', '..', 'src', 'web-dashboard');
const child = spawn('npm', ['run', 'dev'], {
  cwd: dashboard,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, RCA_API_URL: out.ApiEndpoint, RCA_ORIGIN_SECRET: value },
});
child.on('exit', (code) => process.exit(code ?? 0));
