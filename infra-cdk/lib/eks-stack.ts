import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import { Construct } from 'constructs';
import { SUBNET_PRIVATE_APP } from './vpc-stack';

export interface EksStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
}

export class EksStack extends cdk.Stack {
  public readonly cluster: eks.Cluster;

  constructor(scope: Construct, id: string, props: EksStackProps) {
    super(scope, id, props);

    // Newest minor within kubectl's +/-1 version skew of the workstation's v1.34 client.
    this.cluster = new eks.Cluster(this, 'Cluster', {
      version: eks.KubernetesVersion.V1_35,
      vpc: props.vpc,
      vpcSubnets: [{ subnetGroupName: SUBNET_PRIVATE_APP }],
      // Public + private API endpoint so kubectl works from a laptop.
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      defaultCapacityType: eks.DefaultCapacityType.NODEGROUP,
      // Node group is declared below so subnets and sizing are explicit.
      defaultCapacity: 0,
      // Default true: the IAM principal that runs `cdk deploy` gets cluster-admin
      // via an access entry, so `aws eks update-kubeconfig` + kubectl just works.
      bootstrapClusterCreatorAdminPermissions: true,
    });

    // Workloads (Online Boutique, OTel Collector) are applied with kubectl from
    // k8s/ and src/collector/, not through CDK, so no kubectl-handler Lambda.
    this.cluster.addNodegroupCapacity('PrivateAppNodes', {
      // m7i-flex.large (2 vCPU / 8 GB) is the largest type a Free Tier-plan account may launch;
      // t3.large fails there with "instance type is not eligible for Free Tier".
      instanceTypes: [new ec2.InstanceType('m7i-flex.large')],
      amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
      minSize: 2,
      desiredSize: 2,
      maxSize: 3,
      subnets: { subnetGroupName: SUBNET_PRIVATE_APP },
    });

    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
  }
}
