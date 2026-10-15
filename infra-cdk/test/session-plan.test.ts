import {
  APP_STACKS,
  CONCURRENCY,
  downDestroyArgs,
  formatDuration,
  gateForUp,
  isProjectLambda,
  isProjectTable,
  judgeTeardown,
  missingDependencies,
  parseCdkList,
  parseDownArgs,
  parseUpArgs,
  phaseSummary,
  planDown,
  REQUIRED_DEPENDENCIES,
  resolveAlertEmails,
  StackDependencies,
  TeardownSnapshot,
  upDeployArgs,
  upStacks,
} from '../scripts/session-plan';

describe('up: arguments and alert email', () => {
  test('defaults, flags, and contradictions', () => {
    expect(parseUpArgs([])).toEqual({ noEmail: false, dashboard: true, dryRun: false });
    expect(parseUpArgs(['--email=a@x.com,b@y.com', '--no-dashboard', '--dry-run'])).toEqual({
      email: 'a@x.com,b@y.com',
      noEmail: false,
      dashboard: false,
      dryRun: true,
    });
    expect(parseUpArgs(['--email=a@x.com', '--no-email'])).toEqual({ error: expect.stringMatching(/contradict/) });
    expect(parseUpArgs(['--emial=a@x.com'])).toEqual({ error: expect.stringMatching(/Unknown option "--emial=a@x.com"/) });
  });

  test('source priority: --email, then the shell, then .env', () => {
    const all = { flag: 'f@x.com', shell: 's@x.com', file: 'e@x.com', noEmail: false };
    expect(resolveAlertEmails(all)).toEqual({ emails: ['f@x.com'], source: '--email' });
    expect(resolveAlertEmails({ ...all, flag: undefined })).toEqual({ emails: ['s@x.com'], source: 'shell environment' });
    expect(resolveAlertEmails({ ...all, flag: undefined, shell: undefined })).toEqual({ emails: ['e@x.com'], source: 'infra-cdk/.env' });
    // A blank shell variable does not hide the .env value.
    expect(resolveAlertEmails({ ...all, flag: undefined, shell: '  ' })).toEqual({ emails: ['e@x.com'], source: 'infra-cdk/.env' });
  });

  test('a comma-separated list is passed through, de-duplicated', () => {
    expect(resolveAlertEmails({ noEmail: false, file: 'naveen@example.com, team@example.com,naveen@example.com' })).toEqual({
      emails: ['naveen@example.com', 'team@example.com'],
      source: 'infra-cdk/.env',
    });
  });

  test('--no-email is the only way to deploy without email; nothing configured is an error', () => {
    expect(resolveAlertEmails({ noEmail: true, file: 'e@x.com' })).toEqual({ emails: [], source: '--no-email' });
    expect(resolveAlertEmails({ noEmail: false })).toEqual({ error: expect.stringMatching(/No alert email.*--no-email/) });
    expect(resolveAlertEmails({ noEmail: false, flag: '' })).toEqual({ error: expect.stringMatching(/--email gives no email address/) });
  });

  test('a typo fails before anything deploys, naming its source', () => {
    expect(resolveAlertEmails({ noEmail: false, file: 'a@x.com;b@y.com' })).toEqual({
      error: expect.stringMatching(/^infra-cdk\/\.env: Not an email address/),
    });
  });
});

describe('up: the deploy command', () => {
  test('every stack in one parallel deploy, with the full feature flags and the addresses', () => {
    const args = upDeployArgs(upStacks(true), ['a@x.com', 'b@y.com']);
    expect(args.slice(0, 1 + APP_STACKS.length)).toEqual(['deploy', ...APP_STACKS]);
    const tail = args.slice(1 + APP_STACKS.length);
    expect(tail).toEqual([
      '--concurrency', String(CONCURRENCY), '--require-approval', 'never',
      '-c', 'graphBackend=neptune', '-c', 'topology=neptune', '-c', 'alertEmail=a@x.com,b@y.com',
    ]);
  });

  test('--no-dashboard leaves out ApiStack and FrontendStack only; --no-email leaves out alertEmail', () => {
    expect(upStacks(false)).toEqual(APP_STACKS.filter((s) => s !== 'ApiStack' && s !== 'FrontendStack'));
    expect(upDeployArgs(upStacks(false), []).join(' ')).not.toMatch(/alertEmail/);
  });

  test('the gate stops on in-flight and failed stacks, ignores other apps and deleted stacks', () => {
    expect(
      gateForUp([
        { name: 'CDKToolkit', status: 'UPDATE_ROLLBACK_FAILED' },
        { name: 'SomeOtherStack', status: 'CREATE_IN_PROGRESS' },
        { name: 'VpcStack', status: 'CREATE_COMPLETE' },
        { name: 'EksStack', status: 'UPDATE_ROLLBACK_COMPLETE' },
        { name: 'DynamodbStack', status: 'DELETE_COMPLETE' },
      ]),
    ).toEqual([]);
    const problems = gateForUp([
      { name: 'MskStack', status: 'CREATE_IN_PROGRESS' },
      { name: 'FrontendStack', status: 'ROLLBACK_COMPLETE' },
      { name: 'NeptuneStack', status: 'DELETE_FAILED' },
    ]);
    expect(problems).toEqual([
      expect.stringMatching(/^MskStack is CREATE_IN_PROGRESS: wait/),
      expect.stringMatching(/^FrontendStack is ROLLBACK_COMPLETE: run `npm run down`/),
      expect.stringMatching(/^NeptuneStack is DELETE_FAILED: run `npm run down`/),
    ]);
  });
});

describe('down', () => {
  test('arguments', () => {
    expect(parseDownArgs([])).toEqual({ yes: false, dryRun: false });
    expect(parseDownArgs(['--yes', '--dry-run'])).toEqual({ yes: true, dryRun: true });
    expect(parseDownArgs(['-y'])).toEqual({ error: expect.stringMatching(/Unknown option "-y"/) });
  });

  test('destroys only this app\'s present stacks, including failed ones, never CDKToolkit', () => {
    const plan = planDown([
      { name: 'CDKToolkit', status: 'CREATE_COMPLETE' },
      { name: 'FrontendStack', status: 'ROLLBACK_COMPLETE' },
      { name: 'VpcStack', status: 'CREATE_COMPLETE' },
      { name: 'NeptuneStack', status: 'DELETE_FAILED' },
      { name: 'MskStack', status: 'DELETE_COMPLETE' },
    ]);
    expect(plan).toEqual({ destroy: ['VpcStack', 'NeptuneStack', 'FrontendStack'], problems: [] });
  });

  test('an operation in flight blocks the teardown', () => {
    expect(planDown([{ name: 'EksStack', status: 'UPDATE_IN_PROGRESS' }]).problems).toEqual([
      expect.stringMatching(/^EksStack is UPDATE_IN_PROGRESS: wait/),
    ]);
  });

  test('the destroy command always carries the full feature flags (weak references)', () => {
    expect(downDestroyArgs(['VpcStack', 'ApiStack'])).toEqual([
      'destroy', 'VpcStack', 'ApiStack', '--force', '--concurrency', String(CONCURRENCY),
      '-c', 'graphBackend=neptune', '-c', 'topology=neptune',
    ]);
    expect(() => downDestroyArgs(['CDKToolkit'])).toThrow(/outside this app: CDKToolkit/);
    expect(() => downDestroyArgs([])).toThrow(/no stacks/);
  });
});

describe('dependency guard', () => {
  const node = (id: string, deps: StackDependencies[] = []): StackDependencies => ({ id, dependencies: deps });
  const vpc = node('VpcStack');
  const ddb = node('DynamodbStack');
  const neptune = node('NeptuneStack', [vpc]);
  const msk = node('MskStack', [vpc]);
  const api = node('ApiStack', [ddb, neptune, vpc]);
  const full: StackDependencies[] = [
    vpc,
    node('EksStack', [vpc]),
    msk,
    neptune,
    ddb,
    node('SagemakerStack'),
    node('TransformerStack', [msk, neptune, vpc]),
    node('ScorerStack', [neptune, ddb, vpc]),
    node('AlertingStack', [ddb]),
    api,
    // Transitive edges count: FrontendStack reaches VpcStack only through ApiStack.
    node('FrontendStack', [api]),
  ];

  test('the real graph (as `cdk list -d --json` prints it) passes', () => {
    expect(missingDependencies(full)).toEqual([]);
  });

  test('a lost edge or a missing stack is reported', () => {
    const noTopology = full.map((s) => (s.id === 'ApiStack' ? node('ApiStack', [ddb]) : s));
    expect(missingDependencies(noTopology)).toEqual(['ApiStack does not depend on NeptuneStack', 'ApiStack does not depend on VpcStack']);
    expect(missingDependencies(full.filter((s) => s.id !== 'ScorerStack'))).toEqual(['ScorerStack is missing from the CDK app']);
  });

  test('every required edge names real stacks', () => {
    for (const [from, to] of REQUIRED_DEPENDENCIES) {
      expect(APP_STACKS).toContain(from);
      expect(APP_STACKS).toContain(to);
    }
  });

  test('CLI output with a notice line before the JSON still parses', () => {
    expect(parseCdkList('AI agent detected\n[{"id":"VpcStack","dependencies":[]}]')).toEqual([vpc]);
    expect(() => parseCdkList('Error: something')).toThrow(/no JSON array/);
  });
});

describe('verify:teardown judging', () => {
  const empty = (): TeardownSnapshot => ({
    stacks: { items: ['CDKToolkit (CREATE_COMPLETE)'] },
    eksClusters: { items: [] },
    mskClusters: { items: [] },
    neptuneClusters: { items: [] },
    sagemakerEndpoints: { items: [] },
    dynamodbTables: { items: [] },
    cloudfrontDistributions: { items: [] },
    projectVpcs: { items: [] },
    natGateways: { items: [] },
    elasticIps: { items: [] },
    loadBalancers: { items: [] },
    ec2Instances: { items: [] },
    lambdaFunctions: { items: [] },
  });

  test('an empty account with only CDKToolkit passes every check', () => {
    const checks = judgeTeardown(empty());
    expect(checks).toHaveLength(13);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  test('a leftover stack or resource fails, naming it', () => {
    const snap = empty();
    snap.stacks = { items: ['CDKToolkit (CREATE_COMPLETE)', 'VpcStack (DELETE_FAILED)'] };
    snap.natGateways = { items: ['nat-0abc'] };
    const failed = judgeTeardown(snap).filter((c) => !c.ok);
    expect(failed.map((c) => c.detail)).toEqual(['VpcStack (DELETE_FAILED)', 'nat-0abc']);
  });

  test('a query that failed is a FAIL, never a silent pass', () => {
    const snap = empty();
    snap.mskClusters = { error: 'AccessDenied' };
    const msk = judgeTeardown(snap).find((c) => c.name === 'MSK clusters')!;
    expect(msk).toEqual({ name: 'MSK clusters', ok: false, detail: 'could not check: AccessDenied' });
  });

  test('project name filters', () => {
    expect(isProjectTable('rca-incidents')).toBe(true);
    expect(isProjectTable('someone-elses-table')).toBe(false);
    expect(isProjectLambda('ScorerStack-ScorerFunction1A2B-xyz')).toBe(true);
    expect(isProjectLambda('rca-something')).toBe(true);
    expect(isProjectLambda('VpcStackish-fn')).toBe(false);
    expect(isProjectLambda('unrelated-function')).toBe(false);
  });
});

describe('timing', () => {
  test('durations and the summary table', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59_400)).toBe('59s');
    expect(formatDuration(125_000)).toBe('2m 05s');
    const lines = phaseSummary([
      { name: 'preflight', ms: 4_000, ok: true },
      { name: 'cdk deploy', ms: 1_920_000, ok: false },
    ]);
    // Names padded to the longest, durations right-aligned in 8 columns.
    expect(lines).toEqual(['  preflight         4s', '  cdk deploy   32m 00s  (FAILED)', '  total        32m 04s']);
  });
});
