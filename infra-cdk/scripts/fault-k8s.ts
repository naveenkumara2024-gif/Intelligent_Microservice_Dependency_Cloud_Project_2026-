// Applies and undoes Stage 14 faults on the live cluster (kubectl, pinned to the EKS context).
// The plan (what to change, how to undo it) comes from fault-plan.ts; this file only executes it
// and remembers what it did in .fault-state.json, so `fault clear` can always restore the
// deployment exactly, even from a different shell or after the demo script crashed.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { kubectl, kubectlJson } from './aws-cli';
import { Command, DeploymentView, FaultRecord, NAMESPACE, planFault, rolloutStatus, selectForClear } from './fault-plan';

export const STATE_FILE = path.join(__dirname, '..', '.fault-state.json');

export function loadRecords(): FaultRecord[] {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as FaultRecord[];
  } catch {
    return [];
  }
}

function saveRecords(records: FaultRecord[]): void {
  if (records.length === 0) fs.rmSync(STATE_FILE, { force: true });
  else fs.writeFileSync(STATE_FILE, JSON.stringify(records, null, 2) + '\n');
}

export function readDeployment(service: string): { value?: DeploymentView; error?: string } {
  return kubectlJson<DeploymentView>(['get', 'deployment', service, '-n', NAMESPACE]);
}

/** Waits for the new pods to serve; a fault that never rolls out is not a fault. */
function waitRollout(service: string): { ok: boolean; detail: string } {
  const r = kubectl(rolloutStatus(service));
  return { ok: r.ok, detail: r.ok ? r.stdout.trim().split('\n').pop() ?? 'rolled out' : r.stderr };
}

export function applyFault(cmd: Extract<Command, { kind: 'latency' | 'cpu' }>, nowMs = Date.now()): { record?: FaultRecord; error?: string } {
  const records = loadRecords();
  if (records.some((r) => r.service === cmd.service)) {
    return { error: `a fault is already recorded on ${cmd.service}; run \`npm run fault -- clear\` first` };
  }
  const live = readDeployment(cmd.service);
  if (!live.value) return { error: live.error ?? `deployment/${cmd.service} not found` };

  const plan = planFault(cmd, live.value);
  if ('error' in plan) return { error: plan.error };

  // Record the undo BEFORE changing anything: if the apply half-succeeds, clear can still restore.
  const record: FaultRecord = { ...plan.record, appliedAtMs: nowMs };
  saveRecords([...records, record]);
  const applied = kubectl(plan.apply);
  if (!applied.ok) {
    saveRecords(records);
    return { error: `kubectl ${plan.apply.join(' ')} failed: ${applied.stderr}` };
  }
  const rollout = waitRollout(cmd.service);
  if (!rollout.ok) return { record, error: `applied, but the rollout did not complete: ${rollout.detail}` };
  // The time that matters for the demo is when the slow pods started serving.
  record.appliedAtMs = Date.now();
  saveRecords([...records, record]);
  return { record };
}

export function clearFaults(service?: string): { cleared: FaultRecord[]; errors: string[] } {
  const records = loadRecords();
  const targets = selectForClear(records, service);
  const errors: string[] = [];
  const cleared: FaultRecord[] = [];
  for (const record of targets) {
    const r = kubectl(record.undo);
    if (!r.ok) {
      errors.push(`${record.service}: kubectl ${record.undo.join(' ')} failed: ${r.stderr}`);
      continue;
    }
    const rollout = waitRollout(record.service);
    if (!rollout.ok) errors.push(`${record.service}: undo applied but rollout incomplete: ${rollout.detail}`);
    cleared.push(record);
  }
  saveRecords(records.filter((r) => !cleared.includes(r)));
  return { cleared, errors };
}

/** What the live deployments say right now, independent of the state file. */
export function liveFaultView(service: string): { extraLatency?: string; cpuLimit?: string; cpuRequest?: string; error?: string } {
  const live = readDeployment(service);
  if (!live.value) return { error: live.error };
  const c = live.value.spec.template.spec.containers[0];
  return {
    extraLatency: c?.env?.find((e) => e.name === 'EXTRA_LATENCY')?.value,
    cpuLimit: c?.resources?.limits?.cpu,
    cpuRequest: c?.resources?.requests?.cpu,
  };
}
