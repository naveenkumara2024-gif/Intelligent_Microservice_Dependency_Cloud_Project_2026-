import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { NEPTUNE_ENGINE_VERSION, NeptuneStack } from '../lib/neptune-stack';
import { VpcStack } from '../lib/vpc-stack';

const env = { region: 'us-east-1' };

function build(readReplica?: boolean) {
  const app = new cdk.App();
  const vpcStack = new VpcStack(app, 'TestVpcStack', { env });
  const stack = new NeptuneStack(app, 'TestNeptuneStack', { env, vpc: vpcStack.vpc, readReplica });
  return { stack, template: Template.fromStack(stack) };
}

const { template } = build();
const only = (type: string) => Object.values(template.findResources(type));

describe('NeptuneStack cluster', () => {
  test('IAM database authentication is on and storage is encrypted with a customer-managed key', () => {
    template.hasResourceProperties('AWS::Neptune::DBCluster', {
      IamAuthEnabled: true,
      StorageEncrypted: true,
      KmsKeyId: Match.anyValue(),
    });
    template.resourceCountIs('AWS::KMS::Key', 1);
    template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  test('engine version is pinned explicitly, never left to the default', () => {
    expect(NEPTUNE_ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    template.hasResourceProperties('AWS::Neptune::DBCluster', { EngineVersion: NEPTUNE_ENGINE_VERSION });
  });

  test('teardown leaves nothing billable: no deletion protection, DeletionPolicy Delete, 1 day of backups', () => {
    template.hasResourceProperties('AWS::Neptune::DBCluster', {
      DeletionProtection: false,
      BackupRetentionPeriod: 1,
    });
    // CloudFormation's default for a Neptune cluster is Snapshot; it must be overridden.
    const [cluster] = only('AWS::Neptune::DBCluster') as any[];
    expect(cluster.DeletionPolicy).toBe('Delete');
    expect(cluster.UpdateReplacePolicy).toBe('Delete');
    const [key] = only('AWS::KMS::Key') as any[];
    expect(key.DeletionPolicy).toBe('Delete');
  });

  test('lives only in the private-data subnets (the tier with no internet route)', () => {
    const [group] = only('AWS::Neptune::DBSubnetGroup') as any[];
    expect(group.Properties.SubnetIds).toHaveLength(2);
    const ids = JSON.stringify(group.Properties.SubnetIds);
    expect(ids).toContain('privatedata');
    expect(ids).not.toContain('privateapp');
    expect(ids).not.toContain('public');
  });
});

describe('NeptuneStack instances', () => {
  test('single writer by default, not publicly accessible, in AZ-1', () => {
    template.resourceCountIs('AWS::Neptune::DBInstance', 1);
    template.hasResourceProperties('AWS::Neptune::DBInstance', {
      DBInstanceClass: 'db.t4g.medium',
      PubliclyAccessible: false,
      AvailabilityZone: 'us-east-1a',
    });
  });

  test('read replica appears only when requested, in AZ-2, after the writer', () => {
    const replicated = build(true).template;
    replicated.resourceCountIs('AWS::Neptune::DBInstance', 2);
    replicated.hasResourceProperties('AWS::Neptune::DBInstance', { AvailabilityZone: 'us-east-1b' });
    const replica = Object.entries(replicated.findResources('AWS::Neptune::DBInstance')).find(
      ([, r]: [string, any]) => r.Properties.AvailabilityZone === 'us-east-1b',
    ) as [string, any];
    expect(replica[1].DependsOn).toEqual(expect.arrayContaining([expect.stringMatching(/^Writer/)]));
  });
});

describe('NeptuneStack network access', () => {
  test('the database security group admits only TCP 8182, only from the private-app subnet CIDRs', () => {
    const groups = only('AWS::EC2::SecurityGroup') as any[];
    const database = groups.find((g) => /Neptune/.test(g.Properties.GroupDescription));
    expect(database).toBeDefined();
    const ingress = database.Properties.SecurityGroupIngress;
    expect(ingress).toHaveLength(2); // one per private-app subnet
    for (const rule of ingress) {
      expect(rule).toMatchObject({ IpProtocol: 'tcp', FromPort: 8182, ToPort: 8182 });
      expect(rule.CidrIp).toMatch(/^10\.0\.\d+\.0\/24$/);
      expect(rule.CidrIp).not.toBe('0.0.0.0/0');
    }
  });
});

describe('NeptuneStack verification probe', () => {
  const probe = () => (only('AWS::Lambda::Function') as any[]).find((f) => f.Properties.Handler === 'probe.handler');

  test('runs in private-app with the bundle entry point and the database URL', () => {
    const p = probe();
    expect(p).toBeDefined();
    expect(p.Properties.Runtime).toBe('nodejs22.x');
    const subnets = JSON.stringify(p.Properties.VpcConfig.SubnetIds);
    expect(subnets).toContain('privateapp');
    expect(subnets).not.toContain('privatedata');
    expect(JSON.stringify(p.Properties.Environment.Variables.GREMLIN_URL)).toContain('/gremlin');
    expect(JSON.stringify(p.Properties.Environment.Variables.GREMLIN_URL)).toContain('wss://');
  });

  test('its Neptune permissions are scoped to this cluster and limited to data actions', () => {
    const statements = (only('AWS::IAM::Policy') as any[]).flatMap((p) => p.Properties.PolicyDocument.Statement);
    const neptune = statements.filter((s) => [].concat(s.Action).some((a: string) => a.startsWith('neptune-db:')));
    expect(neptune).toHaveLength(1);
    expect(neptune[0].Action).toEqual([
      'neptune-db:ReadDataViaQuery',
      'neptune-db:WriteDataViaQuery',
      'neptune-db:DeleteDataViaQuery',
      'neptune-db:GetEngineStatus',
    ]);
    const resource = JSON.stringify(neptune[0].Resource);
    expect(resource).not.toBe('"*"');
    expect(resource).toContain('neptune-db');
    expect(resource).toContain('ClusterResourceId');
  });

  test('logs keep one week and are removed with the stack', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
    const [logGroup] = only('AWS::Logs::LogGroup') as any[];
    expect(logGroup.DeletionPolicy).toBe('Delete');
  });

  test('exports what the verify script reads', () => {
    for (const name of ['ClusterIdentifier', 'ClusterEndpoint', 'ClusterPort', 'ClusterResourceId', 'ProbeFunctionName']) {
      template.hasOutput(name, {});
    }
  });
});
