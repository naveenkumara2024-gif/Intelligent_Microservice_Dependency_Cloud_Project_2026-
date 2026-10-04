// One-time `cdk bootstrap` for the current account in us-east-1. Creates an S3
// bucket, ECR repo and IAM roles in the account, so run it only after approval.
import { spawnSync } from 'node:child_process';
import { awsJson, REGION } from './aws-cli';

const identity = awsJson<{ Account: string }>(['sts', 'get-caller-identity']);
if (!identity.value) {
  console.error(`No AWS credentials: ${identity.error}`);
  process.exit(1);
}

const target = `aws://${identity.value.Account}/${REGION}`;
console.log(`Bootstrapping ${target}`);
const r = spawnSync('npx', ['cdk', 'bootstrap', target], { stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
