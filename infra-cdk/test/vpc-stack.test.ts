import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { VpcStack } from '../lib/vpc-stack';

// Mirror the cdk.json feature flag so the test sees the same resources as a real synth.
const app = new cdk.App({ context: { '@aws-cdk/aws-ec2:restrictDefaultSecurityGroup': true } });
const stack = new VpcStack(app, 'TestVpcStack', { env: { region: 'us-east-1' } });
const template = Template.fromStack(stack);

describe('VpcStack', () => {
  test('VPC uses 10.0.0.0/16', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.0.0.0/16' });
  });

  test('6 subnets: 2 public, 4 private, across 2 AZs', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 6);
    const subnets = template.findResources('AWS::EC2::Subnet');
    const publicSubnets = Object.values(subnets).filter(
      (s) => s.Properties.MapPublicIpOnLaunch === true,
    );
    expect(publicSubnets).toHaveLength(2);
    const azs = new Set(Object.values(subnets).map((s) => s.Properties.AvailabilityZone));
    expect(azs).toEqual(new Set(['us-east-1a', 'us-east-1b']));
  });

  test('exactly one NAT gateway and one internet gateway', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    template.resourceCountIs('AWS::EC2::InternetGateway', 1);
  });

  test('private-data route tables have no default route', () => {
    const routeTables = template.findResources('AWS::EC2::RouteTable');
    const dataTableIds = Object.keys(routeTables).filter((id) => id.includes('privatedata'));
    expect(dataTableIds).toHaveLength(2);

    const routes = template.findResources('AWS::EC2::Route');
    const defaultRouteTables = Object.values(routes)
      .filter((r) => r.Properties.DestinationCidrBlock === '0.0.0.0/0')
      .map((r) => r.Properties.RouteTableId.Ref);
    for (const id of dataTableIds) {
      expect(defaultRouteTables).not.toContain(id);
    }
    // Sanity: the other tiers do have default routes (2 public -> IGW, 2 private-app -> NAT).
    expect(defaultRouteTables).toHaveLength(4);
  });

  test('gateway endpoints for DynamoDB and S3', () => {
    for (const service of ['dynamodb', 's3']) {
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        VpcEndpointType: 'Gateway',
        ServiceName: { 'Fn::Join': ['', ['com.amazonaws.', { Ref: 'AWS::Region' }, `.${service}`]] },
      });
    }
  });

  test('interface endpoints for SageMaker Runtime and SNS with private DNS', () => {
    for (const service of ['sagemaker.runtime', 'sns']) {
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        VpcEndpointType: 'Interface',
        PrivateDnsEnabled: true,
        ServiceName: `com.amazonaws.us-east-1.${service}`,
      });
    }
    template.resourcePropertiesCountIs('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Interface' }, 2);
    template.resourcePropertiesCountIs('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway' }, 2);
  });

  test('endpoint security group allows only 443 from the VPC CIDR', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: Match.stringLikeRegexp('Interface VPC endpoints'),
      SecurityGroupIngress: [
        Match.objectLike({ CidrIp: '10.0.0.0/16', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }),
      ],
    });
  });

  test('flow log captures REJECT traffic to CloudWatch with 1-week retention', () => {
    template.hasResourceProperties('AWS::EC2::FlowLog', {
      TrafficType: 'REJECT',
      LogDestinationType: 'cloud-watch-logs',
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  });

  test('only CDK-managed IAM roles (flow-log delivery, default-SG restrict); no KMS keys', () => {
    // Application roles are created in their owning stacks (see Stage 5 spec, decision 8).
    const roles = Object.values(template.findResources('AWS::IAM::Role'));
    const principals = roles.flatMap((r) =>
      r.Properties.AssumeRolePolicyDocument.Statement.map((s: any) => s.Principal.Service),
    );
    expect(principals.sort()).toEqual(['lambda.amazonaws.com', 'vpc-flow-logs.amazonaws.com']);
    template.resourceCountIs('AWS::KMS::Key', 0);
  });
});
