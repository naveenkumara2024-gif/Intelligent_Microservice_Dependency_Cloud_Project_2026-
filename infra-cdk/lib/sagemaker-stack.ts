import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';

// Built by `python src/ml-engine/build_artifact.py` (gitignored); contains model.pt, metadata.json
// and code/ (inference.py, features.py, model_pure.py). It is the only thing the endpoint needs.
export const ARTIFACT_PATH = path.join(__dirname, '..', '..', 'src', 'ml-engine', 'dist', 'model.tar.gz');

// AWS Deep Learning Container for PyTorch inference (CPU). The image tag was confirmed to exist in
// ECR account 763104351884 (us-east-1). torch_geometric is NOT in it and is not needed: the model
// runs on a plain-PyTorch re-implementation (src/ml-engine/model_pure.py).
export const DLC_ACCOUNT = '763104351884';
export const DLC_REPOSITORY = 'pytorch-inference';
export const DLC_TAG = '2.6.0-cpu-py312-ubuntu22.04-sagemaker';

export const ENDPOINT_NAME = 'rca-root-cause';
export const SERVERLESS_MEMORY_MB = 2048;
// The account's total serverless concurrency quota is 10; one endpoint uses 2 of it.
export const SERVERLESS_MAX_CONCURRENCY = 2;

export interface SagemakerStackProps extends cdk.StackProps {
  /** Override the artifact location (tests). */
  readonly artifactPath?: string;
}

export class SagemakerStack extends cdk.Stack {
  public readonly endpointName = ENDPOINT_NAME;
  public readonly endpointArn: string;

  constructor(scope: Construct, id: string, props: SagemakerStackProps = {}) {
    super(scope, id, props);

    this.endpointArn = this.formatArn({
      service: 'sagemaker',
      resource: 'endpoint',
      resourceName: ENDPOINT_NAME,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });

    // `cdk synth` must keep working on a fresh checkout where the artifact was never built, so a
    // missing artifact yields an empty stack plus a warning. The deploy script builds it first.
    const artifactPath = props.artifactPath ?? ARTIFACT_PATH;
    if (!fs.existsSync(artifactPath)) {
      cdk.Annotations.of(this).addWarning(
        `Model artifact not found at ${artifactPath}; run \`python src/ml-engine/build_artifact.py\` before deploying.`,
      );
      new cdk.CfnOutput(this, 'Status', { value: 'artifact-not-built' });
      return;
    }

    const artifact = new s3assets.Asset(this, 'ModelArtifact', { path: artifactPath });

    // Pre-create the log group so it is removed with the stack (the endpoint would create its own
    // and leave it behind) and retention is bounded.
    const logGroup = new logs.LogGroup(this, 'EndpointLogGroup', {
      logGroupName: `/aws/sagemaker/Endpoints/${ENDPOINT_NAME}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Least privilege (not AmazonSageMakerFullAccess): pull the one DLC repository, read the one
    // artifact object, write the one log group. Roles live in the stack that owns the resource.
    const role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      description: 'SageMaker execution role for the RCA GNN endpoint',
    });
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
        resources: [`arn:${this.partition}:ecr:${this.region}:${DLC_ACCOUNT}:repository/${DLC_REPOSITORY}`],
      }),
    );
    artifact.grantRead(role);
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`],
      }),
    );

    const model = new sagemaker.CfnModel(this, 'Model', {
      executionRoleArn: role.roleArn,
      primaryContainer: {
        image: `${DLC_ACCOUNT}.dkr.ecr.${this.region}.${this.urlSuffix}/${DLC_REPOSITORY}:${DLC_TAG}`,
        modelDataUrl: artifact.s3ObjectUrl,
        environment: {
          SAGEMAKER_PROGRAM: 'inference.py',
          SAGEMAKER_REGION: this.region,
        },
      },
    });

    // Serverless: no instance type, no idle cost, scales to zero between requests.
    const config = new sagemaker.CfnEndpointConfig(this, 'EndpointConfig', {
      productionVariants: [
        {
          variantName: 'AllTraffic',
          modelName: model.attrModelName,
          serverlessConfig: { memorySizeInMb: SERVERLESS_MEMORY_MB, maxConcurrency: SERVERLESS_MAX_CONCURRENCY },
        },
      ],
    });

    const endpoint = new sagemaker.CfnEndpoint(this, 'Endpoint', {
      endpointName: ENDPOINT_NAME,
      endpointConfigName: config.attrEndpointConfigName,
    });
    endpoint.node.addDependency(logGroup);

    // AWS::SageMaker::Endpoint exposes only EndpointArn via GetAtt; the name is the constant above.
    new cdk.CfnOutput(this, 'EndpointName', { value: ENDPOINT_NAME });
    new cdk.CfnOutput(this, 'EndpointArn', { value: endpoint.attrEndpointArn });
    new cdk.CfnOutput(this, 'ModelDataUrl', { value: artifact.s3ObjectUrl });
  }
}
