import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as msk from 'aws-cdk-lib/aws-msk';
import { Construct } from 'constructs';
import { SUBNET_PRIVATE_APP, SUBNET_PRIVATE_DATA } from './vpc-stack';

// Recommended version per the MSK docs (2026-10); "3.9.x" tracks patch releases.
export const KAFKA_VERSION = '3.9.x';
export const BROKER_INSTANCE_TYPE = 'kafka.t3.small';
export const BROKER_TLS_PORT = 9094;
export const TOPICS = ['otel.traces', 'otel.metrics', 'svc.events'];

export interface MskStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
}

export class MskStack extends cdk.Stack {
  public readonly cluster: msk.CfnCluster;

  constructor(scope: Construct, id: string, props: MskStackProps) {
    super(scope, id, props);

    // Clients (EKS pods now, the Stage 8 Lambda later) live in private-app, so the
    // allowlist is those subnets' CIDRs; this avoids coupling MskStack to EksStack.
    const brokerSg = new ec2.SecurityGroup(this, 'BrokerSecurityGroup', {
      vpc: props.vpc,
      description: 'MSK brokers: TLS from the private-app subnets only',
      // Brokers must reach each other and the cluster's metadata nodes. The private-data
      // subnets have no internet route, so open egress cannot leave the VPC anyway.
      allowAllOutbound: true,
    });
    // Broker-to-broker traffic (replication, metadata) needs the group to trust itself.
    brokerSg.addIngressRule(brokerSg, ec2.Port.allTraffic(), 'Broker-to-broker within the cluster');
    for (const subnet of props.vpc.selectSubnets({ subnetGroupName: SUBNET_PRIVATE_APP }).subnets) {
      brokerSg.addIngressRule(
        ec2.Peer.ipv4(subnet.ipv4CidrBlock),
        ec2.Port.tcp(BROKER_TLS_PORT),
        'Kafka TLS from private-app',
      );
    }

    const configuration = new msk.CfnConfiguration(this, 'Configuration', {
      name: 'rca-msk-config',
      kafkaVersionsList: [KAFKA_VERSION],
      // Topics are created explicitly (k8s/kafka-topics); retention kept short to bound storage.
      serverProperties: [
        'auto.create.topics.enable=false',
        'default.replication.factor=2',
        'min.insync.replicas=1',
        'num.partitions=3',
        'log.retention.hours=24',
      ].join('\n'),
    });

    this.cluster = new msk.CfnCluster(this, 'Cluster', {
      clusterName: 'rca-msk',
      kafkaVersion: KAFKA_VERSION,
      numberOfBrokerNodes: 2, // one per AZ
      brokerNodeGroupInfo: {
        instanceType: BROKER_INSTANCE_TYPE,
        clientSubnets: props.vpc.selectSubnets({ subnetGroupName: SUBNET_PRIVATE_DATA }).subnetIds,
        securityGroups: [brokerSg.securityGroupId],
        storageInfo: { ebsStorageInfo: { volumeSize: 10 } },
        connectivityInfo: { publicAccess: { type: 'DISABLED' } },
      },
      // TLS in transit; no client authentication (access is by security group).
      encryptionInfo: { encryptionInTransit: { clientBroker: 'TLS', inCluster: true } },
      clientAuthentication: { unauthenticated: { enabled: true } },
      configurationInfo: {
        arn: configuration.attrArn,
        revision: configuration.attrLatestRevisionRevision,
      },
      enhancedMonitoring: 'DEFAULT',
    });

    new cdk.CfnOutput(this, 'ClusterArn', { value: this.cluster.attrArn });
  }
}
