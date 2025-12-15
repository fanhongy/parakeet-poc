#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ParakeetPocStack } from '../lib/parakeet-poc-stack';

const app = new cdk.App();

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
  // Build with: cd docker && ./build-and-push.sh
  // ecrRepoName: 'parakeet-asr',
  // ecrImageTag: 'latest',
});

