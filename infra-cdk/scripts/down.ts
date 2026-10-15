// Stage 15: tear the whole system down with one command (prompt/stage-15-fast-up-down.md).
//
//   npm run down               asks you to type "destroy" first
//   npm run down -- --yes      no question
//   npm run down -- --dry-run  shows what would happen; deletes nothing
//
// list stacks -> dependency guard -> confirm -> [EKS: kube access, fault clear, pre-destroy] ->
// no load balancer left in the VPC -> ONE parallel `cdk destroy` -> verify:teardown.
// Never touches CDKToolkit. Safe to re-run until verify:teardown passes.
import * as readline from 'node:readline/promises';
import { aws, awsJson, ensureClusterAdmin, kubectl, pinEksContext } from './aws-cli';
import { loadRecords } from './fault-k8s';
import {
  contextArgs,
  downDestroyArgs,
  missingDependencies,
  parseCdkList,
  parseDownArgs,
  phaseSummary,
  planDown,
  SESSION_CONTEXT,
} from './session-plan';
import { captureCdk, liveStackStates, PhaseClock, runCdk, runScript, stackOutput } from './session-run';

const STABLE = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE']);
const clock = new PhaseClock();

function summary(): void {
  if (clock.phases.length === 0) return;
  console.log('\nTime per phase:');
  for (const line of phaseSummary(clock.phases)) console.log(line);
}

/** Load balancers (ELBv2 and Classic) still in the VPC; Kubernetes creates them outside CloudFormation. */
function loadBalancersIn(vpcId: string): { names?: string[]; error?: string } {
  const v2 = awsJson<{ LoadBalancers: { LoadBalancerName: string; VpcId?: string }[] }>(['elbv2', 'describe-load-balancers']);
  const classic = awsJson<{ LoadBalancerDescriptions: { LoadBalancerName: string; VPCId?: string }[] }>(['elb', 'describe-load-balancers']);
  if (!v2.value || !classic.value) return { error: v2.error ?? classic.error };
  return {
    names: [
      ...v2.value.LoadBalancers.filter((l) => l.VpcId === vpcId).map((l) => l.LoadBalancerName),
      ...classic.value.LoadBalancerDescriptions.filter((l) => l.VPCId === vpcId).map((l) => `${l.LoadBalancerName} (classic)`),
    ],
  };
}

/** kubectl access for this IAM identity (the pre-destroy 401 when workloads were deployed by someone else). */
function prepareKubeAccess(): boolean {
  const cluster = pinEksContext();
  if (!cluster.name) {
    console.error(cluster.error);
    return false;
  }
  const kubeconfig = aws(['eks', 'update-kubeconfig', '--name', cluster.name]);
  if (!kubeconfig.ok) {
    console.error(kubeconfig.stderr);
    return false;
  }
  const admin = ensureClusterAdmin(cluster.name);
  if (!admin.principal) {
    console.error(`could not grant cluster-admin: ${admin.error}`);
    return false;
  }
  // Access entries take a few seconds to propagate.
  for (let attempt = 0; attempt < 12; attempt++) {
    if (kubectl(['auth', 'can-i', 'list', 'services', '--all-namespaces']).stdout.trim() === 'yes') return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
  console.error('kubectl is still not authorized after 60s');
  return false;
}

async function confirm(stacks: string[]): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error('Not an interactive terminal: pass --yes to destroy without the question.');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nThis permanently deletes ${stacks.length} stacks and all their data. Type "destroy" to continue: `);
  rl.close();
  return answer.trim() === 'destroy';
}

async function main(): Promise<number> {
  const opts = parseDownArgs(process.argv.slice(2));
  if ('error' in opts) {
    console.error(opts.error);
    return 2;
  }

  const live = liveStackStates();
  if (!live.states) {
    console.error(`Cannot list stacks: ${live.error}`);
    return 1;
  }
  const plan = planDown(live.states);
  for (const p of plan.problems) console.error(p);
  if (plan.problems.length > 0) return 1;

  if (plan.destroy.length === 0) {
    console.log('Nothing of this app is deployed. Checking that nothing billable is left:');
    return runScript('verify-teardown.ts') ? 0 : 1;
  }
  const status = new Map(live.states.map((s) => [s.name, s.status]));
  console.log('Deployed stacks to destroy:');
  for (const s of plan.destroy) console.log(`  ${s.padEnd(17)} ${status.get(s)}`);

  const guardOk = clock.run('dependency guard', () => {
    const r = captureCdk(['list', '--show-dependencies', '--json', ...contextArgs(SESSION_CONTEXT)]);
    if (!r.ok) return false;
    const missing = missingDependencies(parseCdkList(r.stdout));
    for (const m of missing) console.error(`  MISSING: ${m}`);
    if (missing.length === 0) console.log('  every required dependency is present; CDK will delete dependents first');
    return missing.length === 0;
  });
  if (!guardOk) {
    console.error('\nThe CDK app no longer declares the dependencies down relies on; nothing was deleted.');
    return 1;
  }

  const eksLive = STABLE.has(status.get('EksStack') ?? '');
  const destroyArgs = downDestroyArgs(plan.destroy);
  if (opts.dryRun) {
    console.log('\nDry run. A real run would now:');
    if (eksLive) {
      console.log('  grant kubectl access, then:');
      if (loadRecords().length > 0) console.log('  npm run fault -- clear      (a fault is recorded in .fault-state.json)');
      console.log('  npx tsx scripts/pre-destroy.ts');
    }
    console.log('  check that no load balancer (ELBv2 or Classic) is left in the VPC');
    console.log(`  npx cdk ${destroyArgs.join(' ')}`);
    console.log('  npm run verify:teardown');
    summary();
    return 0;
  }

  if (!opts.yes && !(await confirm(plan.destroy))) {
    console.log('Not confirmed; nothing was deleted.');
    return 1;
  }

  if (eksLive) {
    const access = clock.run('kubectl access', prepareKubeAccess);
    if (access && loadRecords().length > 0) {
      // Not fatal: the cluster is about to be deleted either way.
      if (!clock.run('fault clear', () => runScript('fault.ts', ['clear']))) {
        console.warn('  fault clear failed; continuing (the cluster is being deleted). .fault-state.json is left for inspection.');
      }
    }
    if (!access || !clock.run('pre-destroy (Kubernetes load balancers)', () => runScript('pre-destroy.ts'))) {
      console.warn('  Kubernetes-side cleanup did not complete; the AWS-side load balancer check below decides.');
    }
  }

  const vpcId = stackOutput('VpcStack', 'VpcId');
  if (vpcId) {
    const lbOk = clock.run('no load balancer left in the VPC', () => {
      const lbs = loadBalancersIn(vpcId);
      if (!lbs.names) {
        console.error(`  cannot list load balancers: ${lbs.error}`);
        return false;
      }
      for (const n of lbs.names) console.error(`  still present: ${n}`);
      return lbs.names.length === 0;
    });
    if (!lbOk) {
      console.error('\nA load balancer is still in the VPC (it would block the VPC delete and keeps billing). Nothing was deleted.');
      summary();
      return 1;
    }
  }

  const destroyed = clock.run('cdk destroy (all stacks, in parallel)', () => runCdk(destroyArgs));
  const clean = clock.run('verify:teardown', () => runScript('verify-teardown.ts'));
  summary();
  if (!destroyed || !clean) {
    console.error('\nTeardown is not complete. Fix the cause shown above, then run `npm run down` again.');
    return 1;
  }
  console.log('\nEverything is down; only the CDKToolkit bootstrap stack remains.');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
