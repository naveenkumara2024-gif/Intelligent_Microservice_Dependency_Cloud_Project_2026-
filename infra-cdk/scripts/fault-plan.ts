// Pure logic for the Stage 14 fault tool (scripts/fault.ts) and demo (scripts/verify-demo.ts):
// argument parsing, validation, and the exact kubectl changes a fault applies and the ones that
// undo it. No AWS or kubectl here; unit-tested in test/fault-plan.test.ts.
//
// Two real faults (prompt/stage-14-fault-injection-demo.md, decisions 1-2):
//   latency  EXTRA_LATENCY on productcatalogservice. Online Boutique v0.10.7 reads it at startup
//            (Go duration) and sleeps that long inside ListProducts, GetProduct and SearchProducts.
//   cpu      a CPU limit far below the manifest's, starving one span-emitting service.

export const NAMESPACE = 'default';

/** The only Boutique service whose code implements EXTRA_LATENCY (v0.10.7 sources). */
export const LATENCY_SERVICES = ['productcatalogservice'] as const;

/**
 * Services the demo may starve: span-emitting (Stage 6) AND called by another span-emitting
 * service, so the slowdown shows up on a live edge. `frontend` has no caller that emits spans
 * (the loadgenerator does not), so it is excluded.
 */
export const CPU_SERVICES = [
  'checkoutservice',
  'currencyservice',
  'emailservice',
  'paymentservice',
  'productcatalogservice',
  'recommendationservice',
] as const;

export const LATENCY_MIN_MS = 10;
export const LATENCY_MAX_MS = 5000;
export const CPU_MIN_MILLICORES = 5;
/** Must stay well below the manifest's 200m limit, or it is not a fault. */
export const CPU_MAX_MILLICORES = 100;

export type Command =
  | { kind: 'latency'; service: string; delay: string; delayMs: number }
  | { kind: 'cpu'; service: string; limit: string; millicores: number }
  | { kind: 'clear'; service?: string }
  | { kind: 'status' };

const flag = (args: string[], name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

/** "300ms" / "1.5s" -> milliseconds; anything Go's ParseDuration would reject (or we do not allow) -> undefined. */
export function parseDelay(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(text);
  if (!m) return undefined;
  const ms = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
  return Number.isFinite(ms) ? ms : undefined;
}

/** "15m" -> 15 millicores; whole cores and fractions are rejected on purpose (they are not faults). */
export function parseMillicores(text: string): number | undefined {
  const m = /^(\d+)m$/.exec(text);
  return m ? Number(m[1]) : undefined;
}

export function parseFaultArgs(argv: string[]): Command | { error: string } {
  const [kind, ...rest] = argv;
  const service = flag(rest, 'service');
  switch (kind) {
    case 'latency': {
      const target = service ?? 'productcatalogservice';
      if (!(LATENCY_SERVICES as readonly string[]).includes(target)) {
        return { error: `latency faults need EXTRA_LATENCY support; only ${LATENCY_SERVICES.join(', ')} implements it (got "${target}")` };
      }
      const delay = flag(rest, 'delay') ?? '300ms';
      const delayMs = parseDelay(delay);
      if (delayMs === undefined) return { error: `--delay must look like 300ms or 1.5s (got "${delay}")` };
      if (delayMs < LATENCY_MIN_MS || delayMs > LATENCY_MAX_MS) {
        return { error: `--delay must be between ${LATENCY_MIN_MS}ms and ${LATENCY_MAX_MS / 1000}s (got ${delay})` };
      }
      return { kind, service: target, delay, delayMs };
    }
    case 'cpu': {
      if (!service) return { error: `cpu faults need --service=<one of ${CPU_SERVICES.join(', ')}>` };
      if (!(CPU_SERVICES as readonly string[]).includes(service)) {
        return { error: `--service must be a span-emitting service with a span-emitting caller: ${CPU_SERVICES.join(', ')} (got "${service}")` };
      }
      const limit = flag(rest, 'limit') ?? '15m';
      const millicores = parseMillicores(limit);
      if (millicores === undefined) return { error: `--limit must be millicores like 15m (got "${limit}")` };
      if (millicores < CPU_MIN_MILLICORES || millicores > CPU_MAX_MILLICORES) {
        return { error: `--limit must be between ${CPU_MIN_MILLICORES}m and ${CPU_MAX_MILLICORES}m (got ${limit})` };
      }
      return { kind, service, limit, millicores };
    }
    case 'clear':
      if (service !== undefined && !(CPU_SERVICES as readonly string[]).includes(service)) {
        return { error: `unknown --service "${service}"` };
      }
      return { kind, service };
    case 'status':
      return { kind };
    default:
      return { error: 'usage: fault latency [--delay=300ms] | cpu --service=<svc> [--limit=15m] | clear [--service=<svc>] | status' };
  }
}

// --- what is applied, and how it is undone ------------------------------------------------------

/** The parts of a live Deployment the planner needs (from `kubectl get deployment -o json`). */
export interface DeploymentView {
  metadata: { name: string };
  spec: {
    template: {
      spec: {
        containers: {
          name: string;
          env?: { name: string; value?: string }[];
          resources?: { requests?: { cpu?: string }; limits?: { cpu?: string } };
        }[];
      };
    };
  };
}

export interface FaultRecord {
  kind: 'latency' | 'cpu';
  service: string;
  /** What was applied, for the log and the report. */
  applied: string;
  appliedAtMs: number;
  /** kubectl arguments that restore the deployment exactly as it was. */
  undo: string[];
}

export interface Plan {
  apply: string[];
  record: Omit<FaultRecord, 'appliedAtMs'>;
}

const deploymentRef = (service: string) => [`deployment/${service}`, '-n', NAMESPACE];

export function planFault(cmd: Extract<Command, { kind: 'latency' | 'cpu' }>, live: DeploymentView): Plan | { error: string } {
  const container = live.spec.template.spec.containers[0];
  if (!container) return { error: `deployment/${live.metadata.name} has no containers` };
  const target = [...deploymentRef(cmd.service), '-c', container.name];

  if (cmd.kind === 'latency') {
    const existing = container.env?.find((e) => e.name === 'EXTRA_LATENCY')?.value;
    if (existing !== undefined) {
      return { error: `${cmd.service} already has EXTRA_LATENCY=${existing}; run \`fault clear\` first` };
    }
    return {
      apply: ['set', 'env', ...target, `EXTRA_LATENCY=${cmd.delay}`],
      record: {
        kind: 'latency',
        service: cmd.service,
        applied: `EXTRA_LATENCY=${cmd.delay}`,
        // "NAME-" removes the variable; the manifest never sets it.
        undo: ['set', 'env', ...target, 'EXTRA_LATENCY-'],
      },
    };
  }

  const requests = container.resources?.requests?.cpu;
  const limits = container.resources?.limits?.cpu;
  if (!requests || !limits) {
    return { error: `${cmd.service} has no CPU requests/limits to restore (requests=${requests}, limits=${limits})` };
  }
  const currentLimit = parseMillicores(limits);
  if (currentLimit !== undefined && currentLimit <= cmd.millicores) {
    return { error: `${cmd.service} is already limited to ${limits}; a ${cmd.limit} limit would not be a fault (run \`fault clear\`?)` };
  }
  // A request above the limit is rejected by the API server, so the request comes down too.
  return {
    apply: ['set', 'resources', ...target, `--limits=cpu=${cmd.limit}`, `--requests=cpu=${cmd.limit}`],
    record: {
      kind: 'cpu',
      service: cmd.service,
      applied: `cpu limit ${limits} -> ${cmd.limit}`,
      undo: ['set', 'resources', ...target, `--limits=cpu=${limits}`, `--requests=cpu=${requests}`],
    },
  };
}

/** The faults to undo for `clear` (all of them, or one service's). */
export function selectForClear(records: FaultRecord[], service?: string): FaultRecord[] {
  return service ? records.filter((r) => r.service === service) : records;
}

/** Rollout status arguments, to wait until the new pods actually serve. */
export const rolloutStatus = (service: string): string[] => ['rollout', 'status', ...deploymentRef(service), '--timeout=180s'];
