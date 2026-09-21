# Intelligent Microservice Dependency & RCA Framework

An AWS cloud-native microservice dependency analysis and root-cause-analysis
(RCA) framework built on OpenTelemetry, Kafka/MSK, Lambda, Neptune, SageMaker
GNN, SNS, and QuickSight.

## Project structure

```
.github/workflows/     CI/CD pipelines
Architecture/           Architecture diagrams
infra-cdk/              AWS CDK (TypeScript) infrastructure-as-code
src/collector/          OpenTelemetry collector config
src/lambda-transformer/ Lambda function that transforms trace/telemetry data
src/ml-engine/          GNN training and inference (Python)
src/web-dashboard/      Web dashboard frontend
Dataset/                Datasets used for training/evaluation
Docs/                   Project documentation and reports
```

## Prerequisites

- Node.js + TypeScript
- Python 3.10+
- Docker
- AWS CLI v2 (`aws configure` run with a non-root IAM user)
- AWS CDK CLI
- kubectl
- Helm

## Getting started

```bash
# Infrastructure
cd infra-cdk
npm install
npx cdk synth

# Lambda transformer
cd src/lambda-transformer
npm install

# ML engine
cd src/ml-engine
pip install -r requirements.txt
```

## Checkpoint

```bash
cdk --version
kubectl version --client
aws sts get-caller-identity
```

All three should return version/identity info with no auth errors.
