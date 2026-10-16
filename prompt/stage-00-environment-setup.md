Elaborating Stage 0
Why this stage matters

Everything downstream — CDK deploys, Lambda builds, kubectl access — depends on these tools being correctly installed and authenticated before you touch AWS. Get this wrong and you'll be debugging tool versions instead of your architecture later.

1. Core tool installs
Tool	Purpose in your project	Install
Node.js + TypeScript	Runs CDK, and is the language for your Lambda transformer	nvm install --lts then npm install -g typescript
Python 3.10+	GNN training, dataset preprocessing	pyenv, or official installer
Docker	Local Neo4j/Kafka prototyping, building Lambda/EKS container images	Docker Desktop (Mac/Windows) or docker.io (Linux)
AWS CLI v2	Authenticates your machine to AWS, used by CDK under the hood	pip install awscli or official .pkg/.msi
AWS CDK CLI	Deploys your infrastructure-as-code	npm install -g aws-cdk
kubectl	Talks to your EKS cluster once it exists	brew install kubectl / Chocolatey / apt
Helm	Installs the OTel Collector via its Helm chart later	brew install helm / equivalent
2. AWS account, IAM user, and budget alert — the part people skip and regret
Never use your root AWS account credentials day-to-day. Log into the AWS Console → IAM → Users → create a user (e.g. rca-dev) → enable "programmatic access" → attach AdministratorAccess for now (tighten later once you know exactly which services you use) → generate an access key.
Run aws configure locally and paste in that access key, secret key, and set region to us-east-1 (matching your architecture diagram).
Set the budget alert immediately, before anything else is deployed: AWS Console → Billing → Budgets → Create budget → Cost budget → set a monthly threshold (e.g. $10–20) → add an email alert at 80% and 100%. Neptune and MSK in particular will run ~$0.10–0.30/hour each while idle, which adds up fast if you forget to tear them down between sessions.
3. Repo scaffolding
Intelligent-Microservice-RCA-Framework/
├── .github/workflows/
├── architecture/
├── infra-cdk/
│   ├── bin/app.ts
│   └── lib/
├── src/
│   ├── collector/
│   ├── lambda-transformer/
│   ├── ml-engine/
│   └── web-dashboard/
├── dataset/
├── README.md
└── .gitignore
Checkpoint
cdk --version
kubectl version --client
aws sts get-caller-identity

All three should return version/identity info with no auth errors.

Prompt to implement

The installs above (Docker, AWS CLI, Node, kubectl, Helm) need manual, OS-level installation — no agent can click through a GUI installer for you. But once those are on your machine, everything else in Stage 0 — the repo scaffold, cdk init, boilerplate files, git setup — can be automated. Here's a prompt you can hand to an agent with terminal access (Claude Code, or paste into a fresh Claude chat with the computer/bash tool enabled):

I'm setting up Stage 0 of my project "Intelligent-Microservice-RCA-Framework"
(an AWS cloud-native microservice dependency analysis + RCA framework using
OpenTelemetry, Kafka/MSK, Lambda, Neptune, SageMaker GNN, SNS, QuickSight).

Assume Node.js, TypeScript, Python 3.10+, Docker, AWS CLI v2, the AWS CDK CLI,
kubectl, and Helm are already installed and aws configure has been run.

Please:
1. Create this directory structure from the project root:
   Intelligent-Microservice-RCA-Framework/
   ├── .github/workflows/
   ├── architecture/
   ├── infra-cdk/
   ├── src/collector/
   ├── src/lambda-transformer/
   ├── src/ml-engine/
   ├── src/web-dashboard/
   ├── dataset/
   ├── README.md
   └── .gitignore

2. Inside infra-cdk/, run `cdk init app --language typescript` to scaffold
   the CDK project, then create empty placeholder stack files in lib/ for:
   vpc-stack.ts, eks-stack.ts, msk-stack.ts, neptune-stack.ts,
   dynamodb-stack.ts, sagemaker-stack.ts, frontend-stack.ts

3. Inside src/lambda-transformer/, run `npm init -y` and install
   typescript + @types/node as dev dependencies, and add a tsconfig.json.

4. Inside src/ml-engine/, create a requirements.txt with:
   torch, torch-geometric, boto3, pandas, numpy

5. Write a .gitignore covering node_modules, cdk.out, __pycache__, .env,
   and dist/ folders.

6. Initialize git in the project root and make an initial commit.

7. Finally, run `cdk --version`, `kubectl version --client`, and
   `aws sts get-caller-identity` and show me the output so I can confirm
   the checkpoint passes.