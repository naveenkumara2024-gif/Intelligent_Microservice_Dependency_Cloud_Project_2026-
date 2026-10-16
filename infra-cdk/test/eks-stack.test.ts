import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EksStack } from '../lib/eks-stack';
import { VpcStack } from '../lib/vpc-stack';

const env = { region: 'us-east-1' };
const app = new cdk.App();
const vpcStack = new VpcStack(app, 'TestVpcStack', { env });
const stack = new EksStack(app, 'TestEksStack', { env, vpc: vpcStack.vpc });
const template = Template.fromStack(stack);

describe('EksStack', () => {
  test('one cluster, access-entry auth, creator gets admin, public + private endpoint', () => {
    template.resourceCountIs('AWS::EKS::Cluster', 1);
    template.hasResourceProperties('AWS::EKS::Cluster', {
      Version: '1.35',
      AccessConfig: {
        AuthenticationMode: 'API',
        BootstrapClusterCreatorAdminPermissions: true,
      },
      ResourcesVpcConfig: { EndpointPrivateAccess: true, EndpointPublicAccess: true },
    });
  });

  test('control plane ENIs sit in the 2 private-app subnets', () => {
    const cluster = Object.values(template.findResources('AWS::EKS::Cluster'))[0];
    expect(cluster.Properties.ResourcesVpcConfig.SubnetIds).toHaveLength(2);
    const outputs = JSON.stringify(cluster.Properties.ResourcesVpcConfig.SubnetIds);
    expect(outputs).toContain('privateapp');
    expect(outputs).not.toContain('public');
    expect(outputs).not.toContain('privatedata');
  });

  test('one managed node group: 2-3 x m7i-flex.large in private-app subnets', () => {
    template.resourceCountIs('AWS::EKS::Nodegroup', 1);
    template.hasResourceProperties('AWS::EKS::Nodegroup', {
      InstanceTypes: ['m7i-flex.large'],
      AmiType: 'AL2023_x86_64_STANDARD',
      ScalingConfig: { MinSize: 2, DesiredSize: 2, MaxSize: 3 },
    });
    const ng = Object.values(template.findResources('AWS::EKS::Nodegroup'))[0];
    const subnets = JSON.stringify(ng.Properties.Subnets);
    expect(ng.Properties.Subnets).toHaveLength(2);
    expect(subnets).toContain('privateapp');
    expect(subnets).not.toContain('public');
  });

  test('workloads are applied with kubectl, so no kubectl-handler Lambda or custom resources', () => {
    template.resourceCountIs('AWS::Lambda::Function', 0);
    template.resourceCountIs('Custom::AWSCDK-EKS-KubernetesResource', 0);
  });

  test('only the CDK-created cluster and node roles', () => {
    const roles = Object.values(template.findResources('AWS::IAM::Role'));
    const principals = roles.flatMap((r) =>
      r.Properties.AssumeRolePolicyDocument.Statement.map((s: any) => s.Principal.Service),
    );
    expect(principals.sort()).toEqual(['ec2.amazonaws.com', 'eks.amazonaws.com']);
  });
});
