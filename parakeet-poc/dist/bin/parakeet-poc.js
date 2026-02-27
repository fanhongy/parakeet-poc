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
    // ======================================================================
    // ASR Model Configuration
    // ======================================================================
    // Supports both NVIDIA Parakeet (NeMo) and OpenAI Whisper models.
    // 
    // NVIDIA Parakeet models (via NeMo):
    // - nvidia/parakeet-rnnt-1.1b (NeMo 24.05+)
    // - nvidia/parakeet-ctc-1.1b (NeMo 24.05+)
    // - nvidia/parakeet-tdt-1.1b (NeMo 24.05+, best accuracy)
    // - nvidia/parakeet-ctc-0.6b (NeMo 24.05+, smaller/faster)
    // - nvidia/parakeet-tdt-0.6b-v2 (NeMo 24.09+, requires newer container)
    //
    // OpenAI Whisper models (via faster-whisper):
    // - openai/whisper-tiny (39M params, fastest)
    // - openai/whisper-base (74M params)
    // - openai/whisper-small (244M params)
    // - openai/whisper-medium (769M params)
    // - openai/whisper-large-v3 (1.5B params, best accuracy)
    // ======================================================================
    parakeetModel: 'nvidia/parakeet-ctc-0.6b',
    // parakeetModel: 'nvidia/parakeet-rnnt-1.1b',
    // parakeetModel: 'openai/whisper-large-v3',  // Use Whisper instead of Parakeet
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGFyYWtlZXQtcG9jLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vYmluL3BhcmFrZWV0LXBvYy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFDQSx1Q0FBcUM7QUFDckMsbUNBQW1DO0FBQ25DLDZDQUFzQztBQUN0QyxxQ0FBOEQ7QUFDOUQsa0VBQTZEO0FBQzdELDREQUFnRTtBQUVoRSxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztBQUUxQiwyQ0FBMkM7QUFDM0MscUJBQU8sQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksNEJBQWtCLENBQUMsRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBRS9ELHlEQUF5RDtBQUN6RCx5RkFBeUY7QUFDekYsTUFBTSxjQUFjLEdBQUcsSUFBSSx3Q0FBc0IsQ0FBQyxHQUFHLEVBQUUsd0JBQXdCLEVBQUU7SUFDL0UsR0FBRyxFQUFFO1FBQ0gsT0FBTyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CO1FBQ3hDLE1BQU0sRUFBRSxXQUFXO0tBQ3BCO0lBQ0QsdURBQXVEO0lBQ3ZELGtCQUFrQixFQUFFLElBQUk7SUFDeEIscUVBQXFFO0lBQ3JFLDJGQUEyRjtDQUM1RixDQUFDLENBQUM7QUFFSCx3REFBd0Q7QUFDeEQsb0RBQW9EO0FBQ3BELCtDQUErQztBQUMvQyxNQUFNLFdBQVcsR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxhQUFhLENBQUMsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQztBQUV0RixNQUFNLGFBQWEsR0FBRyxJQUFJLHFDQUFnQixDQUFDLEdBQUcsRUFBRSxrQkFBa0IsRUFBRTtJQUNsRSxHQUFHLEVBQUU7UUFDSCxPQUFPLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxtQkFBbUI7UUFDeEMsdUJBQXVCO1FBQ3ZCLE1BQU0sRUFBRSxXQUFXO0tBQ3BCO0lBQ0QsS0FBSyxFQUFFLHVCQUF1QixFQUFFLFdBQVc7SUFDM0MsOENBQThDO0lBQzlDLHlFQUF5RTtJQUN6RSwwQkFBMEI7SUFDMUIseUVBQXlFO0lBQ3pFLGtFQUFrRTtJQUNsRSxHQUFHO0lBQ0gscUNBQXFDO0lBQ3JDLDRDQUE0QztJQUM1QywyQ0FBMkM7SUFDM0MsMERBQTBEO0lBQzFELDJEQUEyRDtJQUMzRCx3RUFBd0U7SUFDeEUsRUFBRTtJQUNGLDhDQUE4QztJQUM5Qyw4Q0FBOEM7SUFDOUMscUNBQXFDO0lBQ3JDLHVDQUF1QztJQUN2Qyx3Q0FBd0M7SUFDeEMseURBQXlEO0lBQ3pELHlFQUF5RTtJQUN6RSxhQUFhLEVBQUUsMEJBQTBCO0lBQ3pDLDhDQUE4QztJQUM5QyxnRkFBZ0Y7SUFFaEYscURBQXFEO0lBQ3JELFdBQVcsRUFBRSxjQUFjO0lBQzNCLFdBQVcsRUFBRSxRQUFRO0lBQ3JCLHVEQUF1RDtJQUN2RCxpS0FBaUs7SUFDakssY0FBYyxFQUFFLFdBQVc7Q0FDNUIsQ0FBQyxDQUFDO0FBRUgsK0VBQStFO0FBQy9FLHVCQUF1QjtBQUN2QiwrRUFBK0U7QUFDL0UsNkVBQTZFO0FBQzdFLGlFQUFpRTtBQUVqRSwrQkFBK0I7QUFDL0IseUJBQWUsQ0FBQyxvQkFBb0IsQ0FBQyxjQUFjLEVBQUU7SUFDbkQ7UUFDRSxFQUFFLEVBQUUsaUJBQWlCO1FBQ3JCLE1BQU0sRUFBRSxvRUFBb0U7S0FDN0U7SUFDRDtRQUNFLEVBQUUsRUFBRSxrQkFBa0I7UUFDdEIsTUFBTSxFQUFFLG9FQUFvRTtLQUM3RTtJQUNEO1FBQ0UsRUFBRSxFQUFFLGtCQUFrQjtRQUN0QixNQUFNLEVBQUUsMERBQTBEO0tBQ25FO0lBQ0Q7UUFDRSxFQUFFLEVBQUUsbUJBQW1CO1FBQ3ZCLE1BQU0sRUFBRSxrRkFBa0Y7S0FDM0Y7Q0FDRixDQUFDLENBQUM7QUFFSCxrQ0FBa0M7QUFDbEMseUJBQWUsQ0FBQyxvQkFBb0IsQ0FBQyxhQUFhLEVBQUU7SUFDbEQ7UUFDRSxFQUFFLEVBQUUsaUJBQWlCO1FBQ3JCLE1BQU0sRUFBRSxpRUFBaUU7S0FDMUU7SUFDRDtRQUNFLEVBQUUsRUFBRSxrQkFBa0I7UUFDdEIsTUFBTSxFQUFFLHdFQUF3RTtLQUNqRjtJQUNEO1FBQ0UsRUFBRSxFQUFFLG1CQUFtQjtRQUN2QixNQUFNLEVBQUUsb0ZBQW9GO0tBQzdGO0lBQ0Q7UUFDRSxFQUFFLEVBQUUsbUJBQW1CO1FBQ3ZCLE1BQU0sRUFBRSxnRkFBZ0Y7S0FDekY7SUFDRDtRQUNFLEVBQUUsRUFBRSxtQkFBbUI7UUFDdkIsTUFBTSxFQUFFLG9FQUFvRTtLQUM3RTtJQUNEO1FBQ0UsRUFBRSxFQUFFLGtCQUFrQjtRQUN0QixNQUFNLEVBQUUsK0RBQStEO0tBQ3hFO0lBQ0Q7UUFDRSxFQUFFLEVBQUUsbUJBQW1CO1FBQ3ZCLE1BQU0sRUFBRSw2RkFBNkY7S0FDdEc7SUFDRDtRQUNFLEVBQUUsRUFBRSxtQkFBbUI7UUFDdkIsTUFBTSxFQUFFLGdFQUFnRTtLQUN6RTtJQUNEO1FBQ0UsRUFBRSxFQUFFLGlCQUFpQjtRQUNyQixNQUFNLEVBQUUsb0ZBQW9GO0tBQzdGO0lBQ0Q7UUFDRSxFQUFFLEVBQUUsbUJBQW1CO1FBQ3ZCLE1BQU0sRUFBRSxnRUFBZ0U7S0FDekU7SUFDRDtRQUNFLEVBQUUsRUFBRSxtQkFBbUI7UUFDdkIsTUFBTSxFQUFFLHlFQUF5RTtLQUNsRjtJQUNEO1FBQ0UsRUFBRSxFQUFFLG1CQUFtQjtRQUN2QixNQUFNLEVBQUUsaUVBQWlFO0tBQzFFO0lBQ0Q7UUFDRSxFQUFFLEVBQUUsbUJBQW1CO1FBQ3ZCLE1BQU0sRUFBRSx3RUFBd0U7S0FDakY7SUFDRDtRQUNFLEVBQUUsRUFBRSxtQkFBbUI7UUFDdkIsTUFBTSxFQUFFLHVFQUF1RTtLQUNoRjtJQUNEO1FBQ0UsRUFBRSxFQUFFLG1CQUFtQjtRQUN2QixNQUFNLEVBQUUsd0VBQXdFO0tBQ2pGO0NBQ0YsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiIyEvdXNyL2Jpbi9lbnYgbm9kZVxuaW1wb3J0ICdzb3VyY2UtbWFwLXN1cHBvcnQvcmVnaXN0ZXInO1xuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IEFzcGVjdHMgfSBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBBd3NTb2x1dGlvbnNDaGVja3MsIE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gJ2Nkay1uYWcnO1xuaW1wb3J0IHsgUGFyYWtlZXRQb2NTdGFjayB9IGZyb20gJy4uL2xpYi9wYXJha2VldC1wb2Mtc3RhY2snO1xuaW1wb3J0IHsgUGFyYWtlZXRDb2RlQnVpbGRTdGFjayB9IGZyb20gJy4uL2xpYi9jb2RlYnVpbGQtc3RhY2snO1xuXG5jb25zdCBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuXG4vLyBBcHBseSBBV1MgU29sdXRpb25zIGNoZWNrcyB0byBhbGwgc3RhY2tzXG5Bc3BlY3RzLm9mKGFwcCkuYWRkKG5ldyBBd3NTb2x1dGlvbnNDaGVja3MoeyB2ZXJib3NlOiB0cnVlIH0pKTtcblxuLy8gQ29kZUJ1aWxkIHN0YWNrIGZvciBidWlsZGluZyBhbmQgcHVzaGluZyBEb2NrZXIgaW1hZ2VzXG4vLyBEZXBsb3kgdGhpcyBmaXJzdCwgdGhlbiB0cmlnZ2VyIGEgYnVpbGQgYmVmb3JlIGRlcGxveWluZyB0aGUgbWFpbiBzdGFjayB3aXRoIEVDUiBpbWFnZVxuY29uc3QgY29kZUJ1aWxkU3RhY2sgPSBuZXcgUGFyYWtlZXRDb2RlQnVpbGRTdGFjayhhcHAsICdQYXJha2VldENvZGVCdWlsZFN0YWNrJywge1xuICBlbnY6IHtcbiAgICBhY2NvdW50OiBwcm9jZXNzLmVudi5DREtfREVGQVVMVF9BQ0NPVU5ULFxuICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gIH0sXG4gIC8vIFVzZSBleGlzdGluZyBFQ1IgcmVwbyAoY3JlYXRlZCBieSBidWlsZC1hbmQtcHVzaC5zaClcbiAgdXNlRXhpc3RpbmdFY3JSZXBvOiB0cnVlLFxuICAvLyBPcHRpb25hbDogcHJvdmlkZSBOR0MgQVBJIGtleSBzZWNyZXQgQVJOIGZvciBwcml2YXRlIE5WSURJQSBpbWFnZXNcbiAgLy8gbmdjQXBpS2V5U2VjcmV0QXJuOiAnYXJuOmF3czpzZWNyZXRzbWFuYWdlcjp1cy1lYXN0LTE6QUNDT1VOVDpzZWNyZXQ6bmdjLWFwaS1rZXktWFhYWFgnLFxufSk7XG5cbi8vIEdldCBpbWFnZSBkaWdlc3QgZnJvbSBjb250ZXh0IG9yIGVudmlyb25tZW50IHZhcmlhYmxlXG4vLyBVc2FnZTogY2RrIGRlcGxveSAtYyBpbWFnZURpZ2VzdD1zaGEyNTY6YWJjMTIzLi4uXG4vLyBPcjogSU1BR0VfRElHRVNUPXNoYTI1NjphYmMxMjMuLi4gY2RrIGRlcGxveVxuY29uc3QgaW1hZ2VEaWdlc3QgPSBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdpbWFnZURpZ2VzdCcpIHx8IHByb2Nlc3MuZW52LklNQUdFX0RJR0VTVDtcblxuY29uc3QgcGFyYWtlZXRTdGFjayA9IG5ldyBQYXJha2VldFBvY1N0YWNrKGFwcCwgJ1BhcmFrZWV0UG9jU3RhY2snLCB7XG4gIGVudjoge1xuICAgIGFjY291bnQ6IHByb2Nlc3MuZW52LkNES19ERUZBVUxUX0FDQ09VTlQsXG4gICAgLy8gcmVnaW9uOiAndXMtd2VzdC0yJyxcbiAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICB9LFxuICB2cGNJZDogJ3ZwYy0wZDZjNTY1NDc2MWNmZDZmZCcsIC8vdXMtZWFzdC0xXG4gIC8vIHZwY0lkOiAndnBjLTA4NWUxMzdlNzZiYTU2MjY4JywgLy91cy13ZXN0LTJcbiAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAvLyBBU1IgTW9kZWwgQ29uZmlndXJhdGlvblxuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gIC8vIFN1cHBvcnRzIGJvdGggTlZJRElBIFBhcmFrZWV0IChOZU1vKSBhbmQgT3BlbkFJIFdoaXNwZXIgbW9kZWxzLlxuICAvLyBcbiAgLy8gTlZJRElBIFBhcmFrZWV0IG1vZGVscyAodmlhIE5lTW8pOlxuICAvLyAtIG52aWRpYS9wYXJha2VldC1ybm50LTEuMWIgKE5lTW8gMjQuMDUrKVxuICAvLyAtIG52aWRpYS9wYXJha2VldC1jdGMtMS4xYiAoTmVNbyAyNC4wNSspXG4gIC8vIC0gbnZpZGlhL3BhcmFrZWV0LXRkdC0xLjFiIChOZU1vIDI0LjA1KywgYmVzdCBhY2N1cmFjeSlcbiAgLy8gLSBudmlkaWEvcGFyYWtlZXQtY3RjLTAuNmIgKE5lTW8gMjQuMDUrLCBzbWFsbGVyL2Zhc3RlcilcbiAgLy8gLSBudmlkaWEvcGFyYWtlZXQtdGR0LTAuNmItdjIgKE5lTW8gMjQuMDkrLCByZXF1aXJlcyBuZXdlciBjb250YWluZXIpXG4gIC8vXG4gIC8vIE9wZW5BSSBXaGlzcGVyIG1vZGVscyAodmlhIGZhc3Rlci13aGlzcGVyKTpcbiAgLy8gLSBvcGVuYWkvd2hpc3Blci10aW55ICgzOU0gcGFyYW1zLCBmYXN0ZXN0KVxuICAvLyAtIG9wZW5haS93aGlzcGVyLWJhc2UgKDc0TSBwYXJhbXMpXG4gIC8vIC0gb3BlbmFpL3doaXNwZXItc21hbGwgKDI0NE0gcGFyYW1zKVxuICAvLyAtIG9wZW5haS93aGlzcGVyLW1lZGl1bSAoNzY5TSBwYXJhbXMpXG4gIC8vIC0gb3BlbmFpL3doaXNwZXItbGFyZ2UtdjMgKDEuNUIgcGFyYW1zLCBiZXN0IGFjY3VyYWN5KVxuICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gIHBhcmFrZWV0TW9kZWw6ICdudmlkaWEvcGFyYWtlZXQtY3RjLTAuNmInLFxuICAvLyBwYXJha2VldE1vZGVsOiAnbnZpZGlhL3BhcmFrZWV0LXJubnQtMS4xYicsXG4gIC8vIHBhcmFrZWV0TW9kZWw6ICdvcGVuYWkvd2hpc3Blci1sYXJnZS12MycsICAvLyBVc2UgV2hpc3BlciBpbnN0ZWFkIG9mIFBhcmFrZWV0XG4gIFxuICAvLyBPcHRpb25hbDogVXNlIHByZS1idWlsdCBFQ1IgaW1hZ2UgKGZhc3RlciBzdGFydHVwKVxuICBlY3JSZXBvTmFtZTogJ3BhcmFrZWV0LWFzcicsXG4gIGVjckltYWdlVGFnOiAnbGF0ZXN0JyxcbiAgLy8gUGFzcyBkaWdlc3QgdG8gdHJpZ2dlciBFQ1MgdXBkYXRlIHdoZW4gaW1hZ2UgY2hhbmdlc1xuICAvLyBHZXQgZGlnZXN0IGFmdGVyIGJ1aWxkOiBhd3MgZWNyIGRlc2NyaWJlLWltYWdlcyAtLXJlcG9zaXRvcnktbmFtZSBwYXJha2VldC1hc3IgLS1pbWFnZS1pZHMgaW1hZ2VUYWc9bGF0ZXN0IC0tcXVlcnkgJ2ltYWdlRGV0YWlsc1swXS5pbWFnZURpZ2VzdCcgLS1vdXRwdXQgdGV4dFxuICBlY3JJbWFnZURpZ2VzdDogaW1hZ2VEaWdlc3QsXG59KTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gQ0RLLU5BRyBTVVBQUkVTU0lPTlNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFRoZXNlIHN1cHByZXNzaW9ucyBkb2N1bWVudCBpbnRlbnRpb25hbCBkZXZpYXRpb25zIGZyb20gQVdTIGJlc3QgcHJhY3RpY2VzXG4vLyBmb3IgdGhpcyBQb0MuIFJldmlldyBhbmQgYWRkcmVzcyBiZWZvcmUgcHJvZHVjdGlvbiBkZXBsb3ltZW50LlxuXG4vLyBDb2RlQnVpbGQgU3RhY2sgU3VwcHJlc3Npb25zXG5OYWdTdXBwcmVzc2lvbnMuYWRkU3RhY2tTdXBwcmVzc2lvbnMoY29kZUJ1aWxkU3RhY2ssIFtcbiAge1xuICAgIGlkOiAnQXdzU29sdXRpb25zLVMxJyxcbiAgICByZWFzb246ICdQb0M6IFMzIGFjY2VzcyBsb2dnaW5nIG5vdCByZXF1aXJlZCBmb3IgYnVpbGQgYXNzZXRzL2NhY2hlIGJ1Y2tldHMnLFxuICB9LFxuICB7XG4gICAgaWQ6ICdBd3NTb2x1dGlvbnMtUzEwJyxcbiAgICByZWFzb246ICdQb0M6IFNTTC1vbmx5IGJ1Y2tldCBwb2xpY3kgbm90IGVuZm9yY2VkIGZvciBpbnRlcm5hbCBidWlsZCBhc3NldHMnLFxuICB9LFxuICB7XG4gICAgaWQ6ICdBd3NTb2x1dGlvbnMtQ0I0JyxcbiAgICByZWFzb246ICdQb0M6IEtNUyBlbmNyeXB0aW9uIG5vdCByZXF1aXJlZCBmb3IgQ29kZUJ1aWxkIGFydGlmYWN0cycsXG4gIH0sXG4gIHtcbiAgICBpZDogJ0F3c1NvbHV0aW9ucy1JQU01JyxcbiAgICByZWFzb246ICdQb0M6IFdpbGRjYXJkIHBlcm1pc3Npb25zIGFjY2VwdGFibGUgZm9yIEVDUiBwdXNoIGFuZCBTMyBhY2Nlc3MgaW4gYnVpbGQgY29udGV4dCcsXG4gIH0sXG5dKTtcblxuLy8gUGFyYWtlZXQgUG9DIFN0YWNrIFN1cHByZXNzaW9uc1xuTmFnU3VwcHJlc3Npb25zLmFkZFN0YWNrU3VwcHJlc3Npb25zKHBhcmFrZWV0U3RhY2ssIFtcbiAge1xuICAgIGlkOiAnQXdzU29sdXRpb25zLVMxJyxcbiAgICByZWFzb246ICdQb0M6IFMzIGFjY2VzcyBsb2dnaW5nIG5vdCByZXF1aXJlZCBmb3IgYXVkaW8gcHJvY2Vzc2luZyBidWNrZXQnLFxuICB9LFxuICB7XG4gICAgaWQ6ICdBd3NTb2x1dGlvbnMtUzEwJyxcbiAgICByZWFzb246ICdQb0M6IFNTTC1vbmx5IGJ1Y2tldCBwb2xpY3kgbm90IGVuZm9yY2VkIGZvciBpbnRlcm5hbCBhdWRpbyBwcm9jZXNzaW5nJyxcbiAgfSxcbiAge1xuICAgIGlkOiAnQXdzU29sdXRpb25zLUlBTTQnLFxuICAgIHJlYXNvbjogJ1BvQzogQVdTIG1hbmFnZWQgcG9saWNpZXMgYWNjZXB0YWJsZSBmb3IgRUNTIHRhc2sgZXhlY3V0aW9uIGFuZCBFQzIgaW5zdGFuY2Ugcm9sZXMnLFxuICB9LFxuICB7XG4gICAgaWQ6ICdBd3NTb2x1dGlvbnMtSUFNNScsXG4gICAgcmVhc29uOiAnUG9DOiBXaWxkY2FyZCBwZXJtaXNzaW9ucyByZXF1aXJlZCBmb3IgUzMgYnVja2V0IGFjY2VzcyBhbmQgQ2xvdWRXYXRjaCBtZXRyaWNzJyxcbiAgfSxcbiAge1xuICAgIGlkOiAnQXdzU29sdXRpb25zLUVDMjMnLFxuICAgIHJlYXNvbjogJ1BvQzogU2VjdXJpdHkgZ3JvdXBzIGFsbG93IFZQQyBDSURSIGZvciBpbnRlcm5hbCBOTEIgY29tbXVuaWNhdGlvbicsXG4gIH0sXG4gIHtcbiAgICBpZDogJ0F3c1NvbHV0aW9ucy1BUzMnLFxuICAgIHJlYXNvbjogJ1BvQzogQVNHIG5vdGlmaWNhdGlvbnMgbm90IHJlcXVpcmVkIGZvciB0aGlzIHByb29mIG9mIGNvbmNlcHQnLFxuICB9LFxuICB7XG4gICAgaWQ6ICdBd3NTb2x1dGlvbnMtRUNTMicsXG4gICAgcmVhc29uOiAnUG9DOiBFbnZpcm9ubWVudCB2YXJpYWJsZXMgdXNlZCBmb3Igbm9uLXNlbnNpdGl2ZSBjb25maWd1cmF0aW9uIChtb2RlbCBuYW1lLCByZWdpb24sIHBvcnRzKScsXG4gIH0sXG4gIHtcbiAgICBpZDogJ0F3c1NvbHV0aW9ucy1FQ1M0JyxcbiAgICByZWFzb246ICdQb0M6IENvbnRhaW5lciBJbnNpZ2h0cyBub3QgcmVxdWlyZWQgZm9yIHRoaXMgcHJvb2Ygb2YgY29uY2VwdCcsXG4gIH0sXG4gIHtcbiAgICBpZDogJ0F3c1NvbHV0aW9ucy1MMScsXG4gICAgcmVhc29uOiAnTGFtYmRhIHVzZXMgUHl0aG9uIDMuMTIgd2hpY2ggaXMgY3VycmVudDsgd2lsbCB1cGRhdGUgd2hlbiBuZXdlciBydW50aW1lIGF2YWlsYWJsZScsXG4gIH0sXG4gIHtcbiAgICBpZDogJ0F3c1NvbHV0aW9ucy1FTEIyJyxcbiAgICByZWFzb246ICdQb0M6IE5MQiBhY2Nlc3MgbG9nZ2luZyBub3QgcmVxdWlyZWQgZm9yIGludGVybmFsIGdSUEMgdHJhZmZpYycsXG4gIH0sXG4gIHtcbiAgICBpZDogJ0F3c1NvbHV0aW9ucy1FQzI2JyxcbiAgICByZWFzb246ICdQb0M6IEVCUyBlbmNyeXB0aW9uIGhhbmRsZWQgYnkgZGVmYXVsdCBBV1MgZW5jcnlwdGlvbiBmb3IgR1BVIGluc3RhbmNlcycsXG4gIH0sXG4gIHtcbiAgICBpZDogJ0F3c1NvbHV0aW9ucy1FQzI4JyxcbiAgICByZWFzb246ICdQb0M6IERldGFpbGVkIG1vbml0b3Jpbmcgbm90IHJlcXVpcmVkIGZvciB0aGlzIHByb29mIG9mIGNvbmNlcHQnLFxuICB9LFxuICB7XG4gICAgaWQ6ICdBd3NTb2x1dGlvbnMtRUMyOScsXG4gICAgcmVhc29uOiAnUG9DOiBBU0cgdGVybWluYXRpb24gcHJvdGVjdGlvbiBub3QgcmVxdWlyZWQgLSBpbnN0YW5jZXMgYXJlIGVwaGVtZXJhbCcsXG4gIH0sXG4gIHtcbiAgICBpZDogJ0F3c1NvbHV0aW9ucy1TTlMyJyxcbiAgICByZWFzb246ICdQb0M6IFNOUyBlbmNyeXB0aW9uIG5vdCByZXF1aXJlZCBmb3IgQVNHIGxpZmVjeWNsZSBob29rIG5vdGlmaWNhdGlvbnMnLFxuICB9LFxuICB7XG4gICAgaWQ6ICdBd3NTb2x1dGlvbnMtU05TMycsXG4gICAgcmVhc29uOiAnUG9DOiBTTlMgU1NMIGVuZm9yY2VtZW50IG5vdCByZXF1aXJlZCBmb3IgaW50ZXJuYWwgQVNHIGxpZmVjeWNsZSBob29rcycsXG4gIH0sXG5dKTtcblxuIl19