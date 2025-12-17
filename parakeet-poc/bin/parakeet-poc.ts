#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ParakeetPocStack } from '../lib/parakeet-poc-stack';
import { ParakeetCodeBuildStack } from '../lib/codebuild-stack';

const app = new cdk.App();

// CodeBuild stack for building and pushing Docker images
// Deploy this first, then trigger a build before deploying the main stack with ECR image
new ParakeetCodeBuildStack(app, 'ParakeetCodeBuildStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  // Use existing ECR repo (created by build-and-push.sh)
  useExistingEcrRepo: true,
  // Optional: provide NGC API key secret ARN for private NVIDIA images
  // ngcApiKeySecretArn: 'arn:aws:secretsmanager:us-east-1:ACCOUNT:secret:ngc-api-key-XXXXX',
});

// Get image digest from context or environment variable
// Usage: cdk deploy -c imageDigest=sha256:abc123...
// Or: IMAGE_DIGEST=sha256:abc123... cdk deploy
const imageDigest = app.node.tryGetContext('imageDigest') || process.env.IMAGE_DIGEST;

new ParakeetPocStack(app, 'ParakeetPocStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // region: 'us-west-2',
    region: 'us-east-1',
  },
  vpcId: 'vpc-0d6c5654761cfd6fd', //us-east-1
  // vpcId: 'vpc-085e137e76ba56268', //us-west-2
  // Easy to switch model variants:
  // - c (default, faster)
  // - parakeet-ctc-1.1b
  // - parakeet-tdt-1.1b (best accuracy)
  // Model variants:
  // - nvidia/parakeet-rnnt-1.1b (NeMo 24.05+)
  // - nvidia/parakeet-ctc-1.1b (NeMo 24.05+)
  // - nvidia/parakeet-tdt-1.1b (NeMo 24.05+)
  // - nvidia/parakeet-ctc-0.6b (NeMo 24.05+, smaller/faster)
  // - nvidia/parakeet-tdt-0.6b-v2 (NeMo 24.09+, requires newer container)
  parakeetModel: 'nvidia/parakeet-ctc-0.6b',
  
  // Optional: Use pre-built ECR image (faster startup)
  ecrRepoName: 'parakeet-asr',
  ecrImageTag: 'latest',
  // Pass digest to trigger ECS update when image changes
  // Get digest after build: aws ecr describe-images --repository-name parakeet-asr --image-ids imageTag=latest --query 'imageDetails[0].imageDigest' --output text
  ecrImageDigest: imageDigest,
});

