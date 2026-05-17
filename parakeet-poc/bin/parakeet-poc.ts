#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { ParakeetPocStack } from '../lib/parakeet-poc-stack';
import { ParakeetCodeBuildStack } from '../lib/codebuild-stack';

const app = new cdk.App();

// Apply AWS Solutions checks to all stacks
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// CodeBuild stack for building and pushing Docker images
// Deploy this first, then trigger a build before deploying the main stack with ECR image
const codeBuildStack = new ParakeetCodeBuildStack(app, 'ParakeetCodeBuildStack', {
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

const parakeetStack = new ParakeetPocStack(app, 'ParakeetPocStack', {
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
  // parakeetModel: 'nvidia/parakeet-rnnt-1.1b',
  
  // Optional: Use pre-built ECR image (faster startup)
  ecrRepoName: 'parakeet-asr',
  ecrImageTag: 'latest',
  // Pass digest to trigger ECS update when image changes
  // Get digest after build: aws ecr describe-images --repository-name parakeet-asr --image-ids imageTag=latest --query 'imageDetails[0].imageDigest' --output text
  ecrImageDigest: imageDigest,
  // TensorRT optimization: set to true if Docker image was built with BUILD_TENSORRT=true
  // Requires TRT engine pre-compiled for target GPU architecture (A10G)
  useTensorRT: false,
});

// ============================================================================
// CDK-NAG SUPPRESSIONS
// ============================================================================
// These suppressions document intentional deviations from AWS best practices
// for this PoC. Review and address before production deployment.

// CodeBuild Stack Suppressions
NagSuppressions.addStackSuppressions(codeBuildStack, [
  {
    id: 'AwsSolutions-S1',
    reason: 'PoC: S3 access logging not required for build assets/cache buckets',
  },
  {
    id: 'AwsSolutions-S10',
    reason: 'PoC: SSL-only bucket policy not enforced for internal build assets',
  },
  {
    id: 'AwsSolutions-CB4',
    reason: 'PoC: KMS encryption not required for CodeBuild artifacts',
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'PoC: Wildcard permissions acceptable for ECR push and S3 access in build context',
  },
]);

// Parakeet PoC Stack Suppressions
NagSuppressions.addStackSuppressions(parakeetStack, [
  {
    id: 'AwsSolutions-S1',
    reason: 'PoC: S3 access logging not required for audio processing bucket',
  },
  {
    id: 'AwsSolutions-S10',
    reason: 'PoC: SSL-only bucket policy not enforced for internal audio processing',
  },
  {
    id: 'AwsSolutions-IAM4',
    reason: 'PoC: AWS managed policies acceptable for ECS task execution and EC2 instance roles',
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'PoC: Wildcard permissions required for S3 bucket access and CloudWatch metrics',
  },
  {
    id: 'AwsSolutions-EC23',
    reason: 'PoC: Security groups allow VPC CIDR for internal NLB communication',
  },
  {
    id: 'AwsSolutions-AS3',
    reason: 'PoC: ASG notifications not required for this proof of concept',
  },
  {
    id: 'AwsSolutions-ECS2',
    reason: 'PoC: Environment variables used for non-sensitive configuration (model name, region, ports)',
  },
  {
    id: 'AwsSolutions-ECS4',
    reason: 'PoC: Container Insights not required for this proof of concept',
  },
  {
    id: 'AwsSolutions-L1',
    reason: 'Lambda uses Python 3.12 which is current; will update when newer runtime available',
  },
  {
    id: 'AwsSolutions-ELB2',
    reason: 'PoC: NLB access logging not required for internal gRPC traffic',
  },
  {
    id: 'AwsSolutions-EC26',
    reason: 'PoC: EBS encryption handled by default AWS encryption for GPU instances',
  },
  {
    id: 'AwsSolutions-EC28',
    reason: 'PoC: Detailed monitoring not required for this proof of concept',
  },
  {
    id: 'AwsSolutions-EC29',
    reason: 'PoC: ASG termination protection not required - instances are ephemeral',
  },
  {
    id: 'AwsSolutions-SNS2',
    reason: 'PoC: SNS encryption not required for ASG lifecycle hook notifications',
  },
  {
    id: 'AwsSolutions-SNS3',
    reason: 'PoC: SNS SSL enforcement not required for internal ASG lifecycle hooks',
  },
]);

