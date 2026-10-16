import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as neptune from 'aws-cdk-lib/aws-neptune';
import { Construct } from 'constructs';
import { BUNDLE_DIR } from './lambda-bundle';
import { AVAILABILITY_ZONES, SUBNET_PRIVATE_APP, SUBNET_PRIVATE_DATA } from './vpc-stack';

// Engine releases document a single Gremlin language version each: 1.4.8.0 lists 3.7.1 as both its
// earliest and latest, while the general compatibility table lists 3.7.1-3.7.3 for >= 1.3.2.0. The
// transformer's client is pinned to 3.7.3 (inside that table range); Stage 9b is what proves the
// pairing. Pinned explicitly so a new default engine can never change the language version silently.
export const NEPTUNE_ENGINE_VERSION = '1.4.8.0';
export const NEPTUNE_INSTANCE_CLASS = 'db.t4g.medium';
export const NEPTUNE_PORT = 8182;
export const PROBE_BUNDLE = 'probe.js';

/** ARN pattern Neptune IAM authentication evaluates: it uses the cluster *resource id* (cluster-XXXX). */
export function neptuneDbArn(scope: Construct, clusterResourceId: string): string {
  return cdk.Stack.of(scope).formatArn({
    service: 'neptune-db',
    resource: clusterResourceId,
    resourceName: '*',
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
}

export interface NeptuneStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  /**
   * Add a read replica in the second AZ (CLAUDE.md target state). Off by default: it doubles the
   * instance cost and verification does not need it. Enable for the demo with `-c neptuneReplica=true`.
   */
  readonly readReplica?: boolean;
}

export class NeptuneStack extends cdk.Stack {
  public readonly cluster: neptune.CfnDBCluster;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly probe: lambda.Function;

  constructor(scope: Construct, id: string, props: NeptuneStackProps) {
    super(scope, id, props);

    // Keys live in the stack that owns the consuming resource (Stage 5 decision), and are removed with it.
    const key = new kms.Key(this, 'StorageKey', {
      description: 'Neptune storage encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Clients (the transformer Lambda, the probe) live in private-app, so the allowlist is those
    // subnets' CIDRs, the same pattern as MskStack; this avoids coupling to the client stacks.
    this.securityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: props.vpc,
      description: 'Neptune: Gremlin/HTTPS from the private-app subnets only',
      // The private-data subnets have no internet route, so open egress cannot leave the VPC.
      allowAllOutbound: true,
    });
    for (const subnet of props.vpc.selectSubnets({ subnetGroupName: SUBNET_PRIVATE_APP }).subnets) {
      this.securityGroup.addIngressRule(
        ec2.Peer.ipv4(subnet.ipv4CidrBlock),
        ec2.Port.tcp(NEPTUNE_PORT),
        'Gremlin and /status from private-app',
      );
    }

    const subnetGroup = new neptune.CfnDBSubnetGroup(this, 'SubnetGroup', {
      dbSubnetGroupDescription: 'Neptune in the private-data tier (no internet route)',
      subnetIds: props.vpc.selectSubnets({ subnetGroupName: SUBNET_PRIVATE_DATA }).subnetIds,
    });

    this.cluster = new neptune.CfnDBCluster(this, 'Cluster', {
      dbClusterIdentifier: 'rca-neptune',
      engineVersion: NEPTUNE_ENGINE_VERSION,
      dbSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroupIds: [this.securityGroup.securityGroupId],
      dbPort: NEPTUNE_PORT,
      iamAuthEnabled: true,
      storageEncrypted: true,
      kmsKeyId: key.keyArn,
      // Teardown must leave nothing billable: no deletion protection, minimal automated backups,
      // and (below) DeletionPolicy Delete, because CloudFormation's default is a final snapshot.
      deletionProtection: false,
      backupRetentionPeriod: 1,
    });
    this.cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const writer = new neptune.CfnDBInstance(this, 'Writer', {
      dbClusterIdentifier: this.cluster.ref,
      dbInstanceClass: NEPTUNE_INSTANCE_CLASS,
      availabilityZone: AVAILABILITY_ZONES[0],
      publiclyAccessible: false,
      autoMinorVersionUpgrade: false,
    });

    if (props.readReplica) {
      const replica = new neptune.CfnDBInstance(this, 'Replica', {
        dbClusterIdentifier: this.cluster.ref,
        dbInstanceClass: NEPTUNE_INSTANCE_CLASS,
        availabilityZone: AVAILABILITY_ZONES[1],
        publiclyAccessible: false,
        autoMinorVersionUpgrade: false,
      });
      // The writer must exist first so it is the primary; the replica joins it.
      replica.addDependency(writer);
    }

    // --- Verification probe -----------------------------------------------------------------
    // Neptune has no public endpoint, so a function inside the VPC is the way to query it from
    // the workstation (via `aws lambda invoke`). It is a test tool, destroyed with this stack.
    const bundled = fs.existsSync(path.join(BUNDLE_DIR, PROBE_BUNDLE));
    if (!bundled) {
      cdk.Annotations.of(this).addWarning(
        `Probe bundle not found at ${path.join(BUNDLE_DIR, PROBE_BUNDLE)}; run \`npm run build\` in src/lambda-transformer before deploying.`,
      );
    }
    const probeSecurityGroup = new ec2.SecurityGroup(this, 'ProbeSecurityGroup', {
      vpc: props.vpc,
      description: 'Neptune verification probe Lambda',
      allowAllOutbound: true,
    });
    this.probe = new lambda.Function(this, 'Probe', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'probe.handler',
      code: bundled
        ? lambda.Code.fromAsset(BUNDLE_DIR)
        : lambda.Code.fromInline('exports.handler = async () => { throw new Error("probe bundle not built"); };'),
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      vpc: props.vpc,
      vpcSubnets: { subnetGroupName: SUBNET_PRIVATE_APP },
      securityGroups: [probeSecurityGroup],
      logGroup: new logs.LogGroup(this, 'ProbeLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        GREMLIN_URL: `wss://${this.cluster.attrEndpoint}:${this.cluster.attrPort}/gremlin`,
      },
    });
    // Scoped to this cluster. Delete is for the probe's own cleanup and the parity reload.
    this.probe.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'neptune-db:ReadDataViaQuery',
          'neptune-db:WriteDataViaQuery',
          'neptune-db:DeleteDataViaQuery',
          'neptune-db:GetEngineStatus',
        ],
        resources: [neptuneDbArn(this, this.cluster.attrClusterResourceId)],
      }),
    );

    new cdk.CfnOutput(this, 'ClusterIdentifier', { value: this.cluster.ref });
    new cdk.CfnOutput(this, 'ClusterEndpoint', { value: this.cluster.attrEndpoint });
    new cdk.CfnOutput(this, 'ClusterPort', { value: this.cluster.attrPort });
    new cdk.CfnOutput(this, 'ClusterResourceId', { value: this.cluster.attrClusterResourceId });
    new cdk.CfnOutput(this, 'ProbeFunctionName', { value: this.probe.functionName });
  }
}
