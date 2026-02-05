#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("source-map-support/register");
const cdk = require("aws-cdk-lib");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cdk_nag_1 = require("cdk-nag");
const parakeet_poc_stack_1 = require("../lib/parakeet-poc-stack");
const codebuild_stack_1 = require("../lib/codebuild-stack");
const app = new cdk.App();
// Apply AWS Solutions checks to all stacks
aws_cdk_lib_1.Aspects.of(app).add(new cdk_nag_1.AwsSolutionsChecks({ verbose: true }));
// CodeBuild stack for building and pushing Docker images
// Deploy this first, then trigger a build before deploying the main stack with ECR image
const codeBuildStack = new codebuild_stack_1.ParakeetCodeBuildStack(app, 'ParakeetCodeBuildStack', {
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
const parakeetStack = new parakeet_poc_stack_1.ParakeetPocStack(app, 'ParakeetPocStack', {
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
});
// ============================================================================
// CDK-NAG SUPPRESSIONS
// ============================================================================
// These suppressions document intentional deviations from AWS best practices
// for this PoC. Review and address before production deployment.
// CodeBuild Stack Suppressions
cdk_nag_1.NagSuppressions.addStackSuppressions(codeBuildStack, [
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
cdk_nag_1.NagSuppressions.addStackSuppressions(parakeetStack, [
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGFyYWtlZXQtcG9jLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vYmluL3BhcmFrZWV0LXBvYy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFDQSx1Q0FBcUM7QUFDckMsbUNBQW1DO0FBQ25DLDZDQUFzQztBQUN0QyxxQ0FBOEQ7QUFDOUQsa0VBQTZEO0FBQzdELDREQUFnRTtBQUVoRSxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztBQUUxQiwyQ0FBMkM7QUFDM0MscUJBQU8sQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksNEJBQWtCLENBQUMsRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBRS9ELHlEQUF5RDtBQUN6RCx5RkFBeUY7QUFDekYsTUFBTSxjQUFjLEdBQUcsSUFBSSx3Q0FBc0IsQ0FBQyxHQUFHLEVBQUUsd0JBQXdCLEVBQUU7SUFDL0UsR0FBRyxFQUFFO1FBQ0gsT0FBTyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CO1FBQ3hDLE1BQU0sRUFBRSxXQUFXO0tBQ3BCO0lBQ0QsdURBQXVEO0lBQ3ZELGtCQUFrQixFQUFFLElBQUk7SUFDeEIscUVBQXFFO0lBQ3JFLDJGQUEyRjtDQUM1RixDQUFDLENBQUM7QUFFSCx3REFBd0Q7QUFDeEQsb0RBQW9EO0FBQ3BELCtDQUErQztBQUMvQyxNQUFNLFdBQVcsR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxhQUFhLENBQUMsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQztBQUV0RixNQUFNLGFBQWEsR0FBRyxJQUFJLHFDQUFnQixDQUFDLEdBQUcsRUFBRSxrQkFBa0IsRUFBRTtJQUNsRSxHQUFHLEVBQUU7UUFDSCxPQUFPLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxtQkFBbUI7UUFDeEMsdUJBQXVCO1FBQ3ZCLE1BQU0sRUFBRSxXQUFXO0tBQ3BCO0lBQ0QsS0FBSyxFQUFFLHVCQUF1QixFQUFFLFdBQVc7SUFDM0MsOENBQThDO0lBQzlDLGlDQUFpQztJQUNqQyx3QkFBd0I7SUFDeEIsc0JBQXNCO0lBQ3RCLHNDQUFzQztJQUN0QyxrQkFBa0I7SUFDbEIsNENBQTRDO0lBQzVDLDJDQUEyQztJQUMzQywyQ0FBMkM7SUFDM0MsMkRBQTJEO0lBQzNELHdFQUF3RTtJQUN4RSxhQUFhLEVBQUUsMEJBQTBCO0lBQ3pDLDhDQUE4QztJQUU5QyxxREFBcUQ7SUFDckQsV0FBVyxFQUFFLGNBQWM7SUFDM0IsV0FBVyxFQUFFLFFBQVE7SUFDckIsdURBQXVEO0lBQ3ZELGlLQUFpSztJQUNqSyxjQUFjLEVBQUUsV0FBVztDQUM1QixDQUFDLENBQUM7QUFFSCwrRUFBK0U7QUFDL0UsdUJBQXVCO0FBQ3ZCLCtFQUErRTtBQUMvRSw2RUFBNkU7QUFDN0UsaUVBQWlFO0FBRWpFLCtCQUErQjtBQUMvQix5QkFBZSxDQUFDLG9CQUFvQixDQUFDLGNBQWMsRUFBRTtJQUNuRDtRQUNFLEVBQUUsRUFBRSxpQkFBaUI7UUFDckIsTUFBTSxFQUFFLG9FQUFvRTtLQUM3RTtJQUNEO1FBQ0UsRUFBRSxFQUFFLGtCQUFrQjtRQUN0QixNQUFNLEVBQUUsb0VBQW9FO0tBQzdFO0lBQ0Q7UUFDRSxFQUFFLEVBQUUsa0JBQWtCO1FBQ3RCLE1BQU0sRUFBRSwwREFBMEQ7S0FDbkU7SUFDRDtRQUNFLEVBQUUsRUFBRSxtQkFBbUI7UUFDdkIsTUFBTSxFQUFFLGtGQUFrRjtLQUMzRjtDQUNGLENBQUMsQ0FBQztBQUVILGtDQUFrQztBQUNsQyx5QkFBZSxDQUFDLG9CQUFvQixDQUFDLGFBQWEsRUFBRTtJQUNsRDtRQUNFLEVBQUUsRUFBRSxpQkFBaUI7UUFDckIsTUFBTSxFQUFFLGlFQUFpRTtLQUMxRTtJQUNEO1FBQ0UsRUFBRSxFQUFFLGtCQUFrQjtRQUN0QixNQUFNLEVBQUUsd0VBQXdFO0tBQ2pGO0lBQ0Q7UUFDRSxFQUFFLEVBQUUsbUJBQW1CO1FBQ3ZCLE1BQU0sRUFBRSxvRkFBb0Y7S0FDN0Y7SUFDRDtRQUNFLEVBQUUsRUFBRSxtQkFBbUI7UUFDdkIsTUFBTSxFQUFFLGdGQUFnRjtLQUN6RjtJQUNEO1FBQ0UsRUFBRSxFQUFFLG1CQUFtQjtRQUN2QixNQUFNLEVBQUUsb0VBQW9FO0tBQzdFO0lBQ0Q7UUFDRSxFQUFFLEVBQUUsa0JBQWtCO1FBQ3RCLE1BQU0sRUFBRSwrREFBK0Q7S0FDeEU7SUFDRDtRQUNFLEVBQUUsRUFBRSxtQkFBbUI7UUFDdkIsTUFBTSxFQUFFLDZGQUE2RjtLQUN0RztJQUNEO1FBQ0UsRUFBRSxFQUFFLG1CQUFtQjtRQUN2QixNQUFNLEVBQUUsZ0VBQWdFO0tBQ3pFO0lBQ0Q7UUFDRSxFQUFFLEVBQUUsaUJBQWlCO1FBQ3JCLE1BQU0sRUFBRSxvRkFBb0Y7S0FDN0Y7SUFDRDtRQUNFLEVBQUUsRUFBRSxtQkFBbUI7UUFDdkIsTUFBTSxFQUFFLGdFQUFnRTtLQUN6RTtJQUNEO1FBQ0UsRUFBRSxFQUFFLG1CQUFtQjtRQUN2QixNQUFNLEVBQUUseUVBQXlFO0tBQ2xGO0lBQ0Q7UUFDRSxFQUFFLEVBQUUsbUJBQW1CO1FBQ3ZCLE1BQU0sRUFBRSxpRUFBaUU7S0FDMUU7SUFDRDtRQUNFLEVBQUUsRUFBRSxtQkFBbUI7UUFDdkIsTUFBTSxFQUFFLHdFQUF3RTtLQUNqRjtJQUNEO1FBQ0UsRUFBRSxFQUFFLG1CQUFtQjtRQUN2QixNQUFNLEVBQUUsdUVBQXVFO0tBQ2hGO0lBQ0Q7UUFDRSxFQUFFLEVBQUUsbUJBQW1CO1FBQ3ZCLE1BQU0sRUFBRSx3RUFBd0U7S0FDakY7Q0FDRixDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIjIS91c3IvYmluL2VudiBub2RlXG5pbXBvcnQgJ3NvdXJjZS1tYXAtc3VwcG9ydC9yZWdpc3Rlcic7XG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgQXNwZWN0cyB9IGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IEF3c1NvbHV0aW9uc0NoZWNrcywgTmFnU3VwcHJlc3Npb25zIH0gZnJvbSAnY2RrLW5hZyc7XG5pbXBvcnQgeyBQYXJha2VldFBvY1N0YWNrIH0gZnJvbSAnLi4vbGliL3BhcmFrZWV0LXBvYy1zdGFjayc7XG5pbXBvcnQgeyBQYXJha2VldENvZGVCdWlsZFN0YWNrIH0gZnJvbSAnLi4vbGliL2NvZGVidWlsZC1zdGFjayc7XG5cbmNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG5cbi8vIEFwcGx5IEFXUyBTb2x1dGlvbnMgY2hlY2tzIHRvIGFsbCBzdGFja3NcbkFzcGVjdHMub2YoYXBwKS5hZGQobmV3IEF3c1NvbHV0aW9uc0NoZWNrcyh7IHZlcmJvc2U6IHRydWUgfSkpO1xuXG4vLyBDb2RlQnVpbGQgc3RhY2sgZm9yIGJ1aWxkaW5nIGFuZCBwdXNoaW5nIERvY2tlciBpbWFnZXNcbi8vIERlcGxveSB0aGlzIGZpcnN0LCB0aGVuIHRyaWdnZXIgYSBidWlsZCBiZWZvcmUgZGVwbG95aW5nIHRoZSBtYWluIHN0YWNrIHdpdGggRUNSIGltYWdlXG5jb25zdCBjb2RlQnVpbGRTdGFjayA9IG5ldyBQYXJha2VldENvZGVCdWlsZFN0YWNrKGFwcCwgJ1BhcmFrZWV0Q29kZUJ1aWxkU3RhY2snLCB7XG4gIGVudjoge1xuICAgIGFjY291bnQ6IHByb2Nlc3MuZW52LkNES19ERUZBVUxUX0FDQ09VTlQsXG4gICAgcmVnaW9uOiAndXMtZWFzdC0xJyxcbiAgfSxcbiAgLy8gVXNlIGV4aXN0aW5nIEVDUiByZXBvIChjcmVhdGVkIGJ5IGJ1aWxkLWFuZC1wdXNoLnNoKVxuICB1c2VFeGlzdGluZ0VjclJlcG86IHRydWUsXG4gIC8vIE9wdGlvbmFsOiBwcm92aWRlIE5HQyBBUEkga2V5IHNlY3JldCBBUk4gZm9yIHByaXZhdGUgTlZJRElBIGltYWdlc1xuICAvLyBuZ2NBcGlLZXlTZWNyZXRBcm46ICdhcm46YXdzOnNlY3JldHNtYW5hZ2VyOnVzLWVhc3QtMTpBQ0NPVU5UOnNlY3JldDpuZ2MtYXBpLWtleS1YWFhYWCcsXG59KTtcblxuLy8gR2V0IGltYWdlIGRpZ2VzdCBmcm9tIGNvbnRleHQgb3IgZW52aXJvbm1lbnQgdmFyaWFibGVcbi8vIFVzYWdlOiBjZGsgZGVwbG95IC1jIGltYWdlRGlnZXN0PXNoYTI1NjphYmMxMjMuLi5cbi8vIE9yOiBJTUFHRV9ESUdFU1Q9c2hhMjU2OmFiYzEyMy4uLiBjZGsgZGVwbG95XG5jb25zdCBpbWFnZURpZ2VzdCA9IGFwcC5ub2RlLnRyeUdldENvbnRleHQoJ2ltYWdlRGlnZXN0JykgfHwgcHJvY2Vzcy5lbnYuSU1BR0VfRElHRVNUO1xuXG5jb25zdCBwYXJha2VldFN0YWNrID0gbmV3IFBhcmFrZWV0UG9jU3RhY2soYXBwLCAnUGFyYWtlZXRQb2NTdGFjaycsIHtcbiAgZW52OiB7XG4gICAgYWNjb3VudDogcHJvY2Vzcy5lbnYuQ0RLX0RFRkFVTFRfQUNDT1VOVCxcbiAgICAvLyByZWdpb246ICd1cy13ZXN0LTInLFxuICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gIH0sXG4gIHZwY0lkOiAndnBjLTBkNmM1NjU0NzYxY2ZkNmZkJywgLy91cy1lYXN0LTFcbiAgLy8gdnBjSWQ6ICd2cGMtMDg1ZTEzN2U3NmJhNTYyNjgnLCAvL3VzLXdlc3QtMlxuICAvLyBFYXN5IHRvIHN3aXRjaCBtb2RlbCB2YXJpYW50czpcbiAgLy8gLSBjIChkZWZhdWx0LCBmYXN0ZXIpXG4gIC8vIC0gcGFyYWtlZXQtY3RjLTEuMWJcbiAgLy8gLSBwYXJha2VldC10ZHQtMS4xYiAoYmVzdCBhY2N1cmFjeSlcbiAgLy8gTW9kZWwgdmFyaWFudHM6XG4gIC8vIC0gbnZpZGlhL3BhcmFrZWV0LXJubnQtMS4xYiAoTmVNbyAyNC4wNSspXG4gIC8vIC0gbnZpZGlhL3BhcmFrZWV0LWN0Yy0xLjFiIChOZU1vIDI0LjA1KylcbiAgLy8gLSBudmlkaWEvcGFyYWtlZXQtdGR0LTEuMWIgKE5lTW8gMjQuMDUrKVxuICAvLyAtIG52aWRpYS9wYXJha2VldC1jdGMtMC42YiAoTmVNbyAyNC4wNSssIHNtYWxsZXIvZmFzdGVyKVxuICAvLyAtIG52aWRpYS9wYXJha2VldC10ZHQtMC42Yi12MiAoTmVNbyAyNC4wOSssIHJlcXVpcmVzIG5ld2VyIGNvbnRhaW5lcilcbiAgcGFyYWtlZXRNb2RlbDogJ252aWRpYS9wYXJha2VldC1jdGMtMC42YicsXG4gIC8vIHBhcmFrZWV0TW9kZWw6ICdudmlkaWEvcGFyYWtlZXQtcm5udC0xLjFiJyxcbiAgXG4gIC8vIE9wdGlvbmFsOiBVc2UgcHJlLWJ1aWx0IEVDUiBpbWFnZSAoZmFzdGVyIHN0YXJ0dXApXG4gIGVjclJlcG9OYW1lOiAncGFyYWtlZXQtYXNyJyxcbiAgZWNySW1hZ2VUYWc6ICdsYXRlc3QnLFxuICAvLyBQYXNzIGRpZ2VzdCB0byB0cmlnZ2VyIEVDUyB1cGRhdGUgd2hlbiBpbWFnZSBjaGFuZ2VzXG4gIC8vIEdldCBkaWdlc3QgYWZ0ZXIgYnVpbGQ6IGF3cyBlY3IgZGVzY3JpYmUtaW1hZ2VzIC0tcmVwb3NpdG9yeS1uYW1lIHBhcmFrZWV0LWFzciAtLWltYWdlLWlkcyBpbWFnZVRhZz1sYXRlc3QgLS1xdWVyeSAnaW1hZ2VEZXRhaWxzWzBdLmltYWdlRGlnZXN0JyAtLW91dHB1dCB0ZXh0XG4gIGVjckltYWdlRGlnZXN0OiBpbWFnZURpZ2VzdCxcbn0pO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBDREstTkFHIFNVUFBSRVNTSU9OU1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gVGhlc2Ugc3VwcHJlc3Npb25zIGRvY3VtZW50IGludGVudGlvbmFsIGRldmlhdGlvbnMgZnJvbSBBV1MgYmVzdCBwcmFjdGljZXNcbi8vIGZvciB0aGlzIFBvQy4gUmV2aWV3IGFuZCBhZGRyZXNzIGJlZm9yZSBwcm9kdWN0aW9uIGRlcGxveW1lbnQuXG5cbi8vIENvZGVCdWlsZCBTdGFjayBTdXBwcmVzc2lvbnNcbk5hZ1N1cHByZXNzaW9ucy5hZGRTdGFja1N1cHByZXNzaW9ucyhjb2RlQnVpbGRTdGFjaywgW1xuICB7XG4gICAgaWQ6ICdBd3NTb2x1dGlvbnMtUzEnLFxuICAgIHJlYXNvbjogJ1BvQzogUzMgYWNjZXNzIGxvZ2dpbmcgbm90IHJlcXVpcmVkIGZvciBidWlsZCBhc3NldHMvY2FjaGUgYnVja2V0cycsXG4gIH0sXG4gIHtcbiAgICBpZDogJ0F3c1NvbHV0aW9ucy1TMTAnLFxuICAgIHJlYXNvbjogJ1BvQzogU1NMLW9ubHkgYnVja2V0IHBvbGljeSBub3QgZW5mb3JjZWQgZm9yIGludGVybmFsIGJ1aWxkIGFzc2V0cycsXG4gIH0sXG4gIHtcbiAgICBpZDogJ0F3c1NvbHV0aW9ucy1DQjQnLFxuICAgIHJlYXNvbjogJ1BvQzogS01TIGVuY3J5cHRpb24gbm90IHJlcXVpcmVkIGZvciBDb2RlQnVpbGQgYXJ0aWZhY3RzJyxcbiAgfSxcbiAge1xuICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTUnLFxuICAgIHJlYXNvbjogJ1BvQzogV2lsZGNhcmQgcGVybWlzc2lvbnMgYWNjZXB0YWJsZSBmb3IgRUNSIHB1c2ggYW5kIFMzIGFjY2VzcyBpbiBidWlsZCBjb250ZXh0JyxcbiAgfSxcbl0pO1xuXG4vLyBQYXJha2VldCBQb0MgU3RhY2sgU3VwcHJlc3Npb25zXG5OYWdTdXBwcmVzc2lvbnMuYWRkU3RhY2tTdXBwcmVzc2lvbnMocGFyYWtlZXRTdGFjaywgW1xuICB7XG4gICAgaWQ6ICdBd3NTb2x1dGlvbnMtUzEnLFxuICAgIHJlYXNvbjogJ1BvQzogUzMgYWNjZXNzIGxvZ2dpbmcgbm90IHJlcXVpcmVkIGZvciBhdWRpbyBwcm9jZXNzaW5nIGJ1Y2tldCcsXG4gIH0sXG4gIHtcbiAgICBpZDogJ0F3c1NvbHV0aW9ucy1TMTAnLFxuICAgIHJlYXNvbjogJ1BvQzogU1NMLW9ubHkgYnVja2V0IHBvbGljeSBub3QgZW5mb3JjZWQgZm9yIGludGVybmFsIGF1ZGlvIHByb2Nlc3NpbmcnLFxuICB9LFxuICB7XG4gICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNCcsXG4gICAgcmVhc29uOiAnUG9DOiBBV1MgbWFuYWdlZCBwb2xpY2llcyBhY2NlcHRhYmxlIGZvciBFQ1MgdGFzayBleGVjdXRpb24gYW5kIEVDMiBpbnN0YW5jZSByb2xlcycsXG4gIH0sXG4gIHtcbiAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JyxcbiAgICByZWFzb246ICdQb0M6IFdpbGRjYXJkIHBlcm1pc3Npb25zIHJlcXVpcmVkIGZvciBTMyBidWNrZXQgYWNjZXNzIGFuZCBDbG91ZFdhdGNoIG1ldHJpY3MnLFxuICB9LFxuICB7XG4gICAgaWQ6ICdBd3NTb2x1dGlvbnMtRUMyMycsXG4gICAgcmVhc29uOiAnUG9DOiBTZWN1cml0eSBncm91cHMgYWxsb3cgVlBDIENJRFIgZm9yIGludGVybmFsIE5MQiBjb21tdW5pY2F0aW9uJyxcbiAgfSxcbiAge1xuICAgIGlkOiAnQXdzU29sdXRpb25zLUFTMycsXG4gICAgcmVhc29uOiAnUG9DOiBBU0cgbm90aWZpY2F0aW9ucyBub3QgcmVxdWlyZWQgZm9yIHRoaXMgcHJvb2Ygb2YgY29uY2VwdCcsXG4gIH0sXG4gIHtcbiAgICBpZDogJ0F3c1NvbHV0aW9ucy1FQ1MyJyxcbiAgICByZWFzb246ICdQb0M6IEVudmlyb25tZW50IHZhcmlhYmxlcyB1c2VkIGZvciBub24tc2Vuc2l0aXZlIGNvbmZpZ3VyYXRpb24gKG1vZGVsIG5hbWUsIHJlZ2lvbiwgcG9ydHMpJyxcbiAgfSxcbiAge1xuICAgIGlkOiAnQXdzU29sdXRpb25zLUVDUzQnLFxuICAgIHJlYXNvbjogJ1BvQzogQ29udGFpbmVyIEluc2lnaHRzIG5vdCByZXF1aXJlZCBmb3IgdGhpcyBwcm9vZiBvZiBjb25jZXB0JyxcbiAgfSxcbiAge1xuICAgIGlkOiAnQXdzU29sdXRpb25zLUwxJyxcbiAgICByZWFzb246ICdMYW1iZGEgdXNlcyBQeXRob24gMy4xMiB3aGljaCBpcyBjdXJyZW50OyB3aWxsIHVwZGF0ZSB3aGVuIG5ld2VyIHJ1bnRpbWUgYXZhaWxhYmxlJyxcbiAgfSxcbiAge1xuICAgIGlkOiAnQXdzU29sdXRpb25zLUVMQjInLFxuICAgIHJlYXNvbjogJ1BvQzogTkxCIGFjY2VzcyBsb2dnaW5nIG5vdCByZXF1aXJlZCBmb3IgaW50ZXJuYWwgZ1JQQyB0cmFmZmljJyxcbiAgfSxcbiAge1xuICAgIGlkOiAnQXdzU29sdXRpb25zLUVDMjYnLFxuICAgIHJlYXNvbjogJ1BvQzogRUJTIGVuY3J5cHRpb24gaGFuZGxlZCBieSBkZWZhdWx0IEFXUyBlbmNyeXB0aW9uIGZvciBHUFUgaW5zdGFuY2VzJyxcbiAgfSxcbiAge1xuICAgIGlkOiAnQXdzU29sdXRpb25zLUVDMjgnLFxuICAgIHJlYXNvbjogJ1BvQzogRGV0YWlsZWQgbW9uaXRvcmluZyBub3QgcmVxdWlyZWQgZm9yIHRoaXMgcHJvb2Ygb2YgY29uY2VwdCcsXG4gIH0sXG4gIHtcbiAgICBpZDogJ0F3c1NvbHV0aW9ucy1FQzI5JyxcbiAgICByZWFzb246ICdQb0M6IEFTRyB0ZXJtaW5hdGlvbiBwcm90ZWN0aW9uIG5vdCByZXF1aXJlZCAtIGluc3RhbmNlcyBhcmUgZXBoZW1lcmFsJyxcbiAgfSxcbiAge1xuICAgIGlkOiAnQXdzU29sdXRpb25zLVNOUzInLFxuICAgIHJlYXNvbjogJ1BvQzogU05TIGVuY3J5cHRpb24gbm90IHJlcXVpcmVkIGZvciBBU0cgbGlmZWN5Y2xlIGhvb2sgbm90aWZpY2F0aW9ucycsXG4gIH0sXG4gIHtcbiAgICBpZDogJ0F3c1NvbHV0aW9ucy1TTlMzJyxcbiAgICByZWFzb246ICdQb0M6IFNOUyBTU0wgZW5mb3JjZW1lbnQgbm90IHJlcXVpcmVkIGZvciBpbnRlcm5hbCBBU0cgbGlmZWN5Y2xlIGhvb2tzJyxcbiAgfSxcbl0pO1xuXG4iXX0=