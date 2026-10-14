import {
  CPU_SERVICES,
  DeploymentView,
  parseDelay,
  parseFaultArgs,
  parseMillicores,
  planFault,
  rolloutStatus,
  selectForClear,
} from '../scripts/fault-plan';

/** As the vendored v0.10.7 manifest deploys it (container `server`, 100m/200m CPU). */
function deployment(name: string, extra: Partial<DeploymentView['spec']['template']['spec']['containers'][0]> = {}): DeploymentView {
  return {
    metadata: { name },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: 'server',
              env: [
                { name: 'PORT', value: '3550' },
                { name: 'ENABLE_TRACING', value: '1' },
              ],
              resources: { requests: { cpu: '100m' }, limits: { cpu: '200m' } },
              ...extra,
            },
          ],
        },
      },
    },
  };
}

describe('parsing', () => {
  test('durations Go accepts and we allow', () => {
    expect(parseDelay('300ms')).toBe(300);
    expect(parseDelay('1.5s')).toBe(1500);
    expect(parseDelay('2s')).toBe(2000);
    for (const bad of ['300', '5m', '1h', '-1s', 'ms', '1.2.3s', ' 300ms']) expect(parseDelay(bad)).toBeUndefined();
  });

  test('CPU quantities in millicores only', () => {
    expect(parseMillicores('15m')).toBe(15);
    for (const bad of ['1', '0.5', '15', '15M', 'm']) expect(parseMillicores(bad)).toBeUndefined();
  });
});

describe('parseFaultArgs', () => {
  test('latency defaults to productcatalogservice and 300ms', () => {
    expect(parseFaultArgs(['latency'])).toEqual({ kind: 'latency', service: 'productcatalogservice', delay: '300ms', delayMs: 300 });
    expect(parseFaultArgs(['latency', '--delay=100ms'])).toMatchObject({ delayMs: 100 });
  });

  test('latency refuses a service that does not implement EXTRA_LATENCY (it would silently do nothing)', () => {
    expect(parseFaultArgs(['latency', '--service=currencyservice'])).toEqual({ error: expect.stringMatching(/only productcatalogservice/) });
  });

  test('latency refuses delays outside 10ms..5s and malformed ones (a bad value crashes the pod)', () => {
    for (const d of ['5ms', '6s', 'abc', '300']) {
      expect(parseFaultArgs(['latency', `--delay=${d}`])).toEqual({ error: expect.any(String) });
    }
  });

  test('cpu needs a known span-emitting service and a millicore limit in range', () => {
    expect(parseFaultArgs(['cpu', '--service=currencyservice'])).toEqual({ kind: 'cpu', service: 'currencyservice', limit: '15m', millicores: 15 });
    expect(parseFaultArgs(['cpu'])).toEqual({ error: expect.stringMatching(/--service/) });
    expect(parseFaultArgs(['cpu', '--service=cartservice'])).toEqual({ error: expect.stringMatching(/span-emitting/) });
    expect(parseFaultArgs(['cpu', '--service=frontend'])).toEqual({ error: expect.any(String) });
    expect(parseFaultArgs(['cpu', '--service=currencyservice', '--limit=2m'])).toEqual({ error: expect.stringMatching(/between/) });
    expect(parseFaultArgs(['cpu', '--service=currencyservice', '--limit=150m'])).toEqual({ error: expect.stringMatching(/between/) });
    expect(parseFaultArgs(['cpu', '--service=currencyservice', '--limit=1'])).toEqual({ error: expect.stringMatching(/millicores/) });
  });

  test('clear and status', () => {
    expect(parseFaultArgs(['clear'])).toEqual({ kind: 'clear', service: undefined });
    expect(parseFaultArgs(['clear', '--service=currencyservice'])).toEqual({ kind: 'clear', service: 'currencyservice' });
    expect(parseFaultArgs(['clear', '--service=nope'])).toEqual({ error: expect.any(String) });
    expect(parseFaultArgs(['status'])).toEqual({ kind: 'status' });
    expect(parseFaultArgs([])).toEqual({ error: expect.stringMatching(/^usage/) });
  });

  test('frontend is not a cpu target: nothing that emits spans calls it, so no edge would slow down', () => {
    expect(CPU_SERVICES).not.toContain('frontend');
  });
});

describe('planFault', () => {
  test('latency: sets the variable on the server container, and the undo removes it', () => {
    const plan = planFault({ kind: 'latency', service: 'productcatalogservice', delay: '300ms', delayMs: 300 }, deployment('productcatalogservice'));
    expect(plan).toEqual({
      apply: ['set', 'env', 'deployment/productcatalogservice', '-n', 'default', '-c', 'server', 'EXTRA_LATENCY=300ms'],
      record: {
        kind: 'latency',
        service: 'productcatalogservice',
        applied: 'EXTRA_LATENCY=300ms',
        undo: ['set', 'env', 'deployment/productcatalogservice', '-n', 'default', '-c', 'server', 'EXTRA_LATENCY-'],
      },
    });
  });

  test('latency refuses to stack on a fault that is already there', () => {
    const live = deployment('productcatalogservice', { env: [{ name: 'EXTRA_LATENCY', value: '1s' }] });
    expect(planFault({ kind: 'latency', service: 'productcatalogservice', delay: '300ms', delayMs: 300 }, live)).toEqual({
      error: expect.stringMatching(/already has EXTRA_LATENCY=1s/),
    });
  });

  test('cpu: lowers limit AND request (a request above the limit is rejected), undo restores both exactly', () => {
    const plan = planFault({ kind: 'cpu', service: 'currencyservice', limit: '15m', millicores: 15 }, deployment('currencyservice'));
    expect(plan).toEqual({
      apply: ['set', 'resources', 'deployment/currencyservice', '-n', 'default', '-c', 'server', '--limits=cpu=15m', '--requests=cpu=15m'],
      record: {
        kind: 'cpu',
        service: 'currencyservice',
        applied: 'cpu limit 200m -> 15m',
        undo: ['set', 'resources', 'deployment/currencyservice', '-n', 'default', '-c', 'server', '--limits=cpu=200m', '--requests=cpu=100m'],
      },
    });
  });

  test('cpu refuses when already throttled, or when there is nothing to restore', () => {
    const throttled = deployment('currencyservice', { resources: { requests: { cpu: '15m' }, limits: { cpu: '15m' } } });
    expect(planFault({ kind: 'cpu', service: 'currencyservice', limit: '15m', millicores: 15 }, throttled)).toEqual({
      error: expect.stringMatching(/already limited/),
    });
    const bare = deployment('currencyservice', { resources: {} });
    expect(planFault({ kind: 'cpu', service: 'currencyservice', limit: '15m', millicores: 15 }, bare)).toEqual({
      error: expect.stringMatching(/no CPU requests\/limits/),
    });
  });

  test('a deployment without containers is an error, not a crash', () => {
    const empty: DeploymentView = { metadata: { name: 'x' }, spec: { template: { spec: { containers: [] } } } };
    expect(planFault({ kind: 'cpu', service: 'currencyservice', limit: '15m', millicores: 15 }, empty)).toEqual({ error: expect.any(String) });
  });
});

describe('clear selection and rollout', () => {
  const records = [
    { kind: 'latency' as const, service: 'productcatalogservice', applied: 'a', appliedAtMs: 1, undo: ['u1'] },
    { kind: 'cpu' as const, service: 'currencyservice', applied: 'b', appliedAtMs: 2, undo: ['u2'] },
  ];

  test('clear undoes everything, or one service', () => {
    expect(selectForClear(records)).toHaveLength(2);
    expect(selectForClear(records, 'currencyservice').map((r) => r.undo)).toEqual([['u2']]);
    expect(selectForClear(records, 'emailservice')).toEqual([]);
  });

  test('rollout waits on the right deployment with a bound', () => {
    expect(rolloutStatus('currencyservice')).toEqual(['rollout', 'status', 'deployment/currencyservice', '-n', 'default', '--timeout=180s']);
  });
});
