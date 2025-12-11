#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ParakeetPocStack } from '../lib/parakeet-poc-stack';

const app = new cdk.App();

new ParakeetPocStack(app, 'ParakeetPocStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  vpcId: 'vpc-0d6c5654761cfd6fd',
  // Easy to switch model variants:
  // - parakeet-rnnt-1.1b (default, faster)
  // - parakeet-ctc-1.1b
  // - parakeet-tdt-1.1b (best accuracy)
  parakeetModel: 'nvidia/parakeet-rnnt-1.1b',
});
