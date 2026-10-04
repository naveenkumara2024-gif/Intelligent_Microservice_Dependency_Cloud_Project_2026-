// Read-only gate to run before any `cdk deploy` (CLAUDE.md cost guardrails).
// Creates nothing. Exits non-zero if any check fails.
import { awsJson, Check, report, REGION } from './aws-cli';

const checks: Check[] = [];

const identity = awsJson<{ Account: string; Arn: string }>(['sts', 'get-caller-identity']);
checks.push({
  name: 'AWS credentials',
  ok: !!identity.value,
  detail: identity.value
    ? `${identity.value.Arn} (account ${identity.value.Account})`
    : `${identity.error} -- configure credentials (e.g. \`aws login\`) first`,
});

const account = identity.value?.Account;
const expected = process.env.CDK_DEFAULT_ACCOUNT;
if (account && expected && expected !== account) {
  checks.push({
    name: 'Account matches CDK_DEFAULT_ACCOUNT',
    ok: false,
    detail: `credentials are for ${account} but CDK_DEFAULT_ACCOUNT=${expected}`,
  });
}

if (account) {
  // Guardrail: never deploy billable infra without a budget alert.
  const budgets = awsJson<{ Budgets?: { BudgetName: string }[] }>([
    'budgets', 'describe-budgets', '--account-id', account,
  ]);
  const names = (budgets.value?.Budgets ?? []).map((b) => b.BudgetName);
  if (budgets.error && process.env.BUDGET_CONFIRMED === '1') {
    checks.push({
      name: 'AWS budget alert',
      ok: true,
      detail: `could not query budgets (${budgets.error}); BUDGET_CONFIRMED=1 set, trusting your manual confirmation`,
    });
  } else {
    checks.push({
      name: 'AWS budget alert',
      ok: names.length > 0,
      detail: budgets.error
        ? `${budgets.error} -- confirm manually in the console, then re-run with BUDGET_CONFIRMED=1`
        : names.length > 0
          ? `found: ${names.join(', ')}`
          : 'no budgets found -- create one before deploying',
    });
  }

  const toolkit = awsJson<{ Stacks: { StackStatus: string }[] }>([
    'cloudformation', 'describe-stacks', '--stack-name', 'CDKToolkit',
  ]);
  const status = toolkit.value?.Stacks?.[0]?.StackStatus ?? '';
  checks.push({
    name: `CDK bootstrap (${REGION})`,
    ok: /^(CREATE|UPDATE)_COMPLETE$/.test(status),
    detail: status || 'CDKToolkit stack not found -- run `npm run bootstrap` (needs separate approval)',
  });
}

process.exit(report(checks) ? 0 : 1);
