// Stage 15: bring the whole system up with one command (prompt/stage-15-fast-up-down.md).
//
//   npm run up                              alert email(s) from RCA_ALERT_EMAIL (shell, else infra-cdk/.env)
//   npm run up -- --email=a@x.com,b@y.com   override the addresses
//   npm run up -- --no-email                deploy without email alerts
//   npm run up -- --no-dashboard            skip ApiStack + FrontendStack (CloudFront)
//   npm run up -- --dry-run                 checks, builds and synth only; deploys nothing
//
// preflight -> stack-state gate -> builds -> ONE parallel `cdk deploy` of every stack in its final
// configuration -> deploy:workloads. Stack contents are exactly what the per-stack scripts deploy;
// only the order and the waiting change. Re-running is safe: CDK skips unchanged stacks.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEnv } from 'node:util';
import {
  contextArgs,
  gateForUp,
  missingDependencies,
  parseCdkList,
  parseUpArgs,
  phaseSummary,
  resolveAlertEmails,
  upContext,
  upDeployArgs,
  upStacks,
} from './session-plan';
import {
  captureCdk,
  INFRA_DIR,
  liveStackStates,
  PhaseClock,
  REPO_ROOT,
  runCdk,
  runNpm,
  runScript,
  stackOutput,
} from './session-run';

const opts = parseUpArgs(process.argv.slice(2));
if ('error' in opts) {
  console.error(opts.error);
  process.exit(2);
}

// .env is parsed into a copy, not loaded into process.env, so a shell value keeps priority and the
// printed source is the true one.
const envFile = path.join(INFRA_DIR, '.env');
const fileEmail = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')).RCA_ALERT_EMAIL : undefined;
const alert = resolveAlertEmails({ flag: opts.email, noEmail: opts.noEmail, shell: process.env.RCA_ALERT_EMAIL, file: fileEmail });
if ('error' in alert) {
  console.error(alert.error);
  process.exit(2);
}
console.log(
  alert.emails.length > 0
    ? `Alert email (${alert.source}): ${alert.emails.join(', ')}`
    : 'Alert email: none (--no-email); Slack/PagerDuty Lambdas still subscribe',
);

const stacks = upStacks(opts.dashboard);
const deployArgs = upDeployArgs(stacks, alert.emails);
const clock = new PhaseClock();

function finish(code: number, message?: string): never {
  if (message) console.error(`\n${message}`);
  console.log('\nTime per phase:');
  for (const line of phaseSummary(clock.phases)) console.log(line);
  process.exit(code);
}

if (!clock.run('preflight', () => runScript('preflight.ts'))) {
  finish(1, 'Preflight failed; nothing was deployed.');
}

const gateProblems: string[] = [];
if (
  !clock.run('stack-state gate', () => {
    const live = liveStackStates();
    if (!live.states) {
      gateProblems.push(`cannot list stacks: ${live.error}`);
      return false;
    }
    gateProblems.push(...gateForUp(live.states));
    for (const p of gateProblems) console.error(`  ${p}`);
    return gateProblems.length === 0;
  })
) {
  finish(1, 'A stack is not in a state that can be deployed over; nothing was deployed.');
}

const builds: [string, () => boolean][] = [
  ['build: Lambda bundles', () => runNpm(path.join(REPO_ROOT, 'src', 'lambda-transformer'), 'build')],
  ['build: model artifact', () => runScript('build-model.ts')],
];
if (opts.dashboard) builds.push(['build: dashboard', () => runNpm(path.join(REPO_ROOT, 'src', 'web-dashboard'), 'build')]);
for (const [name, fn] of builds) {
  if (!clock.run(name, fn)) finish(1, `${name} failed; nothing was deployed.`);
}

if (opts.dryRun) {
  const ok = clock.run('synth + dependency order', () => {
    const r = captureCdk(['list', '--show-dependencies', '--json', ...contextArgs(upContext(alert.emails))]);
    if (!r.ok) return false;
    const list = parseCdkList(r.stdout);
    for (const s of list) {
      const after = s.dependencies.map((d) => d.id);
      const mark = stacks.includes(s.id) ? '' : '   (not deployed: --no-dashboard)';
      console.log(`  ${s.id.padEnd(17)} ${after.length ? `after ${after.join(', ')}` : 'starts immediately'}${mark}`);
    }
    const missing = missingDependencies(list);
    for (const m of missing) console.error(`  MISSING: ${m}`);
    return missing.length === 0;
  });
  console.log('\nDry run. A real run would now execute:');
  console.log(`  npx cdk ${deployArgs.join(' ')}`);
  console.log('  npm run deploy:workloads');
  finish(ok ? 0 : 1, ok ? undefined : 'Synth or the dependency check failed.');
}

if (!clock.run('cdk deploy (all stacks, in parallel)', () => runCdk(deployArgs))) {
  finish(
    1,
    'cdk deploy failed. Fix the cause shown above and run `npm run up` again: stacks that finished are kept and skipped.\n' +
      'To remove everything instead: `npm run down`.',
  );
}

if (!clock.run('deploy:workloads', () => runScript('deploy-workloads.ts'))) {
  finish(1, 'Workloads failed; the AWS stacks are up. Fix the cause and run `npm run deploy:workloads`.');
}

console.log('\nSystem is up.');
const cluster = stackOutput('EksStack', 'ClusterName');
if (cluster) console.log(`  EKS cluster:  ${cluster}`);
const dashboard = opts.dashboard ? stackOutput('FrontendStack', 'DashboardUrl') : undefined;
if (dashboard) console.log(`  Dashboard:    ${dashboard}`);
if (alert.emails.length > 0) {
  console.log(`  Alert emails: ${alert.emails.join(', ')}`);
  console.log('                each address gets an "AWS Notification - Subscription Confirmation" email;');
  console.log('                alerts reach only the addresses whose owner clicks "Confirm subscription".');
}
console.log('\nNext: npm run verify:eks, npm run verify:live, npm run verify:demo');
console.log('When finished: npm run down');
finish(0);
