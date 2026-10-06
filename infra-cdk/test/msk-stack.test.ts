import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { MskStack } from '../lib/msk-stack';
import { VpcStack } from '../lib/vpc-stack';

const env = { region: 'us-east-1' };
const app = new cdk.App();
const vpcStack = new VpcStack(app, 'TestVpcStack', { env });
const stack = new MskStack(app, 'TestMskStack', { env, vpc: vpcStack.vpc });
const template = Template.fromStack(stack);

describe('MskStack', () => {
  test('provisioned cluster: 2 x kafka.t3.small, Kafka 3.9.x', () => {
    template.resourceCountIs('AWS::MSK::Cluster', 1);
    template.resourceCountIs('AWS::MSK::ServerlessCluster', 0);
    template.hasResourceProperties('AWS::MSK::Cluster', {
      KafkaVersion: '3.9.x',
      NumberOfBrokerNodes: 2,
      BrokerNodeGroupInfo: Match.objectLike({
        InstanceType: 'kafka.t3.small',
        StorageInfo: { EBSStorageInfo: { VolumeSize: 10 } },
      }),
    });
  });

  test('brokers sit in the 2 private-data subnets, no public access', () => {
    const cluster = Object.values(template.findResources('AWS::MSK::Cluster'))[0];
    const info = cluster.Properties.BrokerNodeGroupInfo;
    expect(info.ClientSubnets).toHaveLength(2);
    const subnets = JSON.stringify(info.ClientSubnets);
    expect(subnets).toContain('privatedata');
    expect(subnets).not.toContain('privateapp');
    expect(subnets).not.toContain('public');
    expect(info.ConnectivityInfo.PublicAccess.Type).toBe('DISABLED');
  });

  test('TLS in transit, unauthenticated clients, at-rest encryption left to the AWS-managed key', () => {
    template.hasResourceProperties('AWS::MSK::Cluster', {
      EncryptionInfo: { EncryptionInTransit: { ClientBroker: 'TLS', InCluster: true } },
      ClientAuthentication: { Unauthenticated: { Enabled: true } },
    });
    const cluster = Object.values(template.findResources('AWS::MSK::Cluster'))[0];
    expect(cluster.Properties.EncryptionInfo.EncryptionAtRest).toBeUndefined();
    template.resourceCountIs('AWS::KMS::Key', 0);
  });

  test('broker security group: clients only on TCP 9094 from the two private-app subnets', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: Match.stringLikeRegexp('MSK brokers'),
    });
    // The only CIDR-based ingress is the client port from private-app; nothing is open to the world.
    const ingress = Object.values(template.findResources('AWS::EC2::SecurityGroup'))[0]
      .Properties.SecurityGroupIngress as any[];
    expect(ingress).toHaveLength(2);
    for (const rule of ingress) {
      expect(rule).toMatchObject({ IpProtocol: 'tcp', FromPort: 9094, ToPort: 9094 });
    }
    expect(ingress.map((r) => r.CidrIp).sort()).toEqual(['10.0.2.0/24', '10.0.3.0/24']);
  });

  test('brokers can talk to each other: self-referencing ingress and open egress', () => {
    // Without these the brokers cannot replicate or reach the metadata nodes.
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: '-1',
      GroupId: Match.anyValue(),
      SourceSecurityGroupId: Match.anyValue(),
    });
    const sg = Object.values(template.findResources('AWS::EC2::SecurityGroup'))[0];
    expect(sg.Properties.SecurityGroupEgress).toEqual([
      expect.objectContaining({ CidrIp: '0.0.0.0/0', IpProtocol: '-1' }),
    ]);
  });

  test('configuration: no auto-create, replication 2, 24 h retention', () => {
    template.resourceCountIs('AWS::MSK::Configuration', 1);
    const config = Object.values(template.findResources('AWS::MSK::Configuration'))[0];
    const props = config.Properties.ServerProperties as string;
    for (const line of [
      'auto.create.topics.enable=false',
      'default.replication.factor=2',
      'min.insync.replicas=1',
      'num.partitions=3',
      'log.retention.hours=24',
    ]) {
      expect(props.split('\n')).toContain(line);
    }
    expect(config.Properties.KafkaVersionsList).toEqual(['3.9.x']);
  });

  test('stack owns no IAM roles or Lambda functions', () => {
    template.resourceCountIs('AWS::IAM::Role', 0);
    template.resourceCountIs('AWS::Lambda::Function', 0);
  });

  test('exports the cluster ARN for the deploy scripts', () => {
    template.hasOutput('ClusterArn', {});
  });
});
