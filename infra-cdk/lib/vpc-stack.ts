import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export const VPC_CIDR = '10.0.0.0/16';
export const AVAILABILITY_ZONES = ['us-east-1a', 'us-east-1b'];

// Subnet group names; the tag `aws-cdk:subnet-name` carries these on the
// deployed subnets, which scripts/verify-vpc.ts relies on.
export const SUBNET_PUBLIC = 'public';
export const SUBNET_PRIVATE_APP = 'private-app';
export const SUBNET_PRIVATE_DATA = 'private-data';

export interface VpcStackProps extends cdk.StackProps {
  /**
   * NAT gateways (each ~$0.045/hr). 1 is enough for a dev/demo; use 2 for
   * per-AZ egress resilience.
   */
  readonly natGateways?: number;
}

export class VpcStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  /** Attach to EKS nodes / Lambda; data-tier SGs (Stages 7/9) take it as an ingress source. */
  public readonly appSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: VpcStackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(VPC_CIDR),
      // Explicit AZs avoid a context lookup, so `cdk synth` needs no credentials.
      availabilityZones: AVAILABILITY_ZONES,
      natGateways: props?.natGateways ?? 1,
      subnetConfiguration: [
        { name: SUBNET_PUBLIC, subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: SUBNET_PRIVATE_APP, subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        // No route to the internet at all: Neptune and MSK live here.
        { name: SUBNET_PRIVATE_DATA, subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      // Gateway endpoints are free and attach to every route table.
      gatewayEndpoints: {
        DynamoDb: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB },
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });

    this.appSecurityGroup = new ec2.SecurityGroup(this, 'AppSecurityGroup', {
      vpc: this.vpc,
      description: 'EKS nodes and Lambda functions in the private-app tier',
      allowAllOutbound: true,
    });

    const endpointSecurityGroup = new ec2.SecurityGroup(this, 'EndpointSecurityGroup', {
      vpc: this.vpc,
      description: 'Interface VPC endpoints: HTTPS from inside the VPC only',
      allowAllOutbound: false,
    });
    endpointSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(VPC_CIDR),
      ec2.Port.tcp(443),
      'HTTPS from within the VPC',
    );

    // Interface endpoints bill hourly per AZ; only the services in CLAUDE.md.
    const interfaceEndpointProps = {
      subnets: { subnetGroupName: SUBNET_PRIVATE_APP },
      securityGroups: [endpointSecurityGroup],
      privateDnsEnabled: true,
      // `open` would add a second, duplicate 443-from-VPC-CIDR rule.
      open: false,
    };
    this.vpc.addInterfaceEndpoint('SageMakerRuntimeEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SAGEMAKER_RUNTIME,
      ...interfaceEndpointProps,
    });
    this.vpc.addInterfaceEndpoint('SnsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SNS,
      ...interfaceEndpointProps,
    });

    // Rejected traffic only: cheap, and shows what the isolated tier blocks.
    this.vpc.addFlowLog('RejectFlowLog', {
      trafficType: ec2.FlowLogTrafficType.REJECT,
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'FlowLogGroup', {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      ),
    });

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}
