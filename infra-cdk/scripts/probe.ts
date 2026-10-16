// Run one action on the in-VPC Neptune probe and print the JSON result.
//   npm run probe -- status
//   npm run probe -- wsdiag
//   npm run probe -- edges '{"limit":20}'      (optional JSON merged into the payload)
//   npm run probe -- degrade '{"service":"paymentservice","calls":200,"latencyMs":70}'
import { awsJson } from './aws-cli';
import { makeProbeInvoker } from './probe-client';

const [action, extra] = process.argv.slice(2);
if (!action) {
  console.error('usage: npm run probe -- <status|unsigned|wsdiag|smoke|concurrency|stats|edges|degrade|clear> [json]');
  process.exit(2);
}
const stack = awsJson<{ Stacks: { Outputs?: { OutputKey: string; OutputValue: string }[] }[] }>([
  'cloudformation', 'describe-stacks', '--stack-name', 'NeptuneStack',
]);
const fn = stack.value?.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'ProbeFunctionName')?.OutputValue;
if (!fn) {
  console.error('NeptuneStack is not deployed (no ProbeFunctionName output)');
  process.exit(1);
}
const result = makeProbeInvoker(fn)({ action, ...(extra ? JSON.parse(extra) : {}) });
if (!result.value) {
  console.error(result.error);
  process.exit(1);
}
console.log(JSON.stringify(result.value, null, 2));
process.exit(result.value.ok ? 0 : 1);
