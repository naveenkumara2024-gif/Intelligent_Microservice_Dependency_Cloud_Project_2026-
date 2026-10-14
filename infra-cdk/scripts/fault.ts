// Stage 14: inject or clear a REAL fault in the running Online Boutique (EKS).
//
//   npm run fault -- latency [--delay=300ms]                     productcatalogservice sleeps in every RPC
//   npm run fault -- cpu --service=currencyservice [--limit=15m] starve a service of CPU
//   npm run fault -- clear [--service=<svc>]                     undo (all faults, or one service)
//   npm run fault -- status                                      what is applied right now
//
// Always clear before tearing the cluster down or ending a session; `verify:demo` clears on exit.
import { aws, pinEksContext } from './aws-cli';
import { applyFault, clearFaults, liveFaultView, loadRecords, STATE_FILE } from './fault-k8s';
import { CPU_SERVICES, parseFaultArgs } from './fault-plan';

const cmd = parseFaultArgs(process.argv.slice(2));
if ('error' in cmd) {
  console.error(cmd.error);
  process.exit(2);
}

const cluster = pinEksContext();
if (!cluster.name) {
  console.error(`EksStack is not deployed: ${cluster.error}`);
  process.exit(1);
}
// Same as expose-storefront: make sure the pinned context exists in this machine's kubeconfig.
const kubeconfig = aws(['eks', 'update-kubeconfig', '--name', cluster.name]);
if (!kubeconfig.ok) {
  console.error(kubeconfig.stderr);
  process.exit(1);
}

switch (cmd.kind) {
  case 'latency':
  case 'cpu': {
    const r = applyFault(cmd);
    if (r.record) console.log(`applied: ${r.record.service}: ${r.record.applied} at ${new Date(r.record.appliedAtMs).toISOString()}`);
    if (r.error) {
      console.error(r.error);
      process.exit(1);
    }
    console.log('Undo with: npm run fault -- clear');
    break;
  }
  case 'clear': {
    const r = clearFaults(cmd.service);
    for (const c of r.cleared) console.log(`cleared: ${c.service} (${c.applied})`);
    if (r.cleared.length === 0 && r.errors.length === 0) console.log('nothing recorded to clear');
    for (const e of r.errors) console.error(e);
    process.exit(r.errors.length > 0 ? 1 : 0);
    break;
  }
  case 'status': {
    const records = loadRecords();
    console.log(records.length === 0 ? `no faults recorded (${STATE_FILE})` : `recorded faults (${STATE_FILE}):`);
    for (const r of records) console.log(`  ${r.service}: ${r.applied} since ${new Date(r.appliedAtMs).toISOString()}`);
    // The state file is a convenience; the deployments are the truth.
    console.log('live deployments:');
    for (const service of CPU_SERVICES) {
      const v = liveFaultView(service);
      if (v.error) console.log(`  ${service}: ${v.error}`);
      else console.log(`  ${service.padEnd(24)} EXTRA_LATENCY=${v.extraLatency ?? '-'}  cpu ${v.cpuRequest ?? '-'}/${v.cpuLimit ?? '-'}`);
    }
    break;
  }
}
