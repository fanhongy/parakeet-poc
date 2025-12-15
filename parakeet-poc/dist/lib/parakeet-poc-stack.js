"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParakeetPocStack = void 0;
const cdk = require("aws-cdk-lib");
const ec2 = require("aws-cdk-lib/aws-ec2");
const ecs = require("aws-cdk-lib/aws-ecs");
const ecr = require("aws-cdk-lib/aws-ecr");
const autoscaling = require("aws-cdk-lib/aws-autoscaling");
const s3 = require("aws-cdk-lib/aws-s3");
const iam = require("aws-cdk-lib/aws-iam");
const logs = require("aws-cdk-lib/aws-logs");
const lambda = require("aws-cdk-lib/aws-lambda");
const s3n = require("aws-cdk-lib/aws-s3-notifications");
const s3deploy = require("aws-cdk-lib/aws-s3-deployment");
const elbv2 = require("aws-cdk-lib/aws-elasticloadbalancingv2");
class ParakeetPocStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Service configurations for dual-path architecture
        const standardConfig = {
            instanceType: 'g4dn.2xlarge',
            chunkDurationSeconds: 30,
            maxAudioDurationMinutes: 60,
            inputPrefix: 'input/',
            serviceName: 'standard',
        };
        // Experimental: No chunking service (requires massive GPU memory, limited to ~15 min audio)
        const noChunkConfig = {
            // instanceType: 'p4de.24xlarge',  // A100 80GB
            instanceType: 'g4dn.2xlarge',
            chunkDurationSeconds: 60 * 10, // 6 chunking, 10 mins each
            maxAudioDurationMinutes: 60, // Limited to ~60 min due to VRAM constraints
            inputPrefix: 'input-nochunk/',
            serviceName: 'no-chunk',
        };
        // Import existing VPC
        const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId });
        // S3 bucket for audio input, transcript output, and scripts
        const bucket = new s3.Bucket(this, 'AudioBucket', {
            bucketName: `parakeet-poc-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });
        // Upload transcribe script and proto files to S3 (deployed via CDK)
        new s3deploy.BucketDeployment(this, 'DeployScript', {
            sources: [
                s3deploy.Source.asset('./scripts'),
                s3deploy.Source.asset('./proto'),
            ],
            destinationBucket: bucket,
            destinationKeyPrefix: 'scripts',
        });
        // Shared ECS Cluster
        const cluster = new ecs.Cluster(this, 'ParakeetCluster', {
            vpc,
            clusterName: 'parakeet-poc-cluster',
        });
        // CloudWatch Log Group (shared)
        const logGroup = new logs.LogGroup(this, 'ParakeetLogs', {
            logGroupName: '/ecs/parakeet-poc',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        // Task execution role (shared)
        const executionRole = new iam.Role(this, 'TaskExecutionRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
            ],
        });
        // Task role for S3 access (shared)
        const taskRole = new iam.Role(this, 'TaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });
        bucket.grantReadWrite(taskRole);
        // Lambda security group (shared)
        const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
            vpc,
            description: 'Security group for Lambda',
            allowAllOutbound: true,
        });
        // Create both services with gRPC
        const standardService = this.createParakeetService(standardConfig, vpc, cluster, bucket, logGroup, executionRole, taskRole, lambdaSecurityGroup, props.parakeetModel, 'Standard', props.ecrRepoName, props.ecrImageTag);
        const noChunkService = this.createParakeetService(noChunkConfig, vpc, cluster, bucket, logGroup, executionRole, taskRole, lambdaSecurityGroup, props.parakeetModel, 'NoChunk', props.ecrRepoName, props.ecrImageTag);
        // Lambda layer for gRPC dependencies
        const grpcLayer = new lambda.LayerVersion(this, 'GrpcLayer', {
            code: lambda.Code.fromAsset('./lambda-layer'),
            compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
            description: 'gRPC and protobuf dependencies for Lambda',
        });
        // Lambda to trigger transcription via gRPC (routes based on prefix)
        const triggerLambda = new lambda.Function(this, 'TriggerLambda', {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index_grpc.handler',
            code: lambda.Code.fromAsset('./lambda'),
            timeout: cdk.Duration.minutes(15),
            memorySize: 256,
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroups: [lambdaSecurityGroup],
            layers: [grpcLayer],
            environment: {
                STANDARD_SERVICE_HOST: standardService.nlb.loadBalancerDnsName,
                STANDARD_SERVICE_PORT: '50051',
                NO_CHUNK_SERVICE_HOST: noChunkService.nlb.loadBalancerDnsName,
                NO_CHUNK_SERVICE_PORT: '50051',
                S3_BUCKET: bucket.bucketName,
                STANDARD_PREFIX: standardConfig.inputPrefix,
                NO_CHUNK_PREFIX: noChunkConfig.inputPrefix,
            },
        });
        // S3 triggers for standard audio (input/)
        bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(triggerLambda), { prefix: standardConfig.inputPrefix, suffix: '.wav' });
        bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(triggerLambda), { prefix: standardConfig.inputPrefix, suffix: '.mp3' });
        // S3 triggers for no-chunk audio (input-nochunk/)
        bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(triggerLambda), { prefix: noChunkConfig.inputPrefix, suffix: '.wav' });
        bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(triggerLambda), { prefix: noChunkConfig.inputPrefix, suffix: '.mp3' });
        // Outputs
        new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
        new cdk.CfnOutput(this, 'StandardServiceHost', {
            value: standardService.nlb.loadBalancerDnsName,
            description: 'Standard gRPC service (30s chunks, up to 60 min audio)',
        });
        new cdk.CfnOutput(this, 'StandardUploadCommand', {
            value: `aws s3 cp your-audio.wav s3://${bucket.bucketName}/${standardConfig.inputPrefix}`,
            description: 'Upload to standard processing',
        });
        new cdk.CfnOutput(this, 'NoChunkServiceHost', {
            value: noChunkService.nlb.loadBalancerDnsName,
            description: 'No-chunk gRPC service (experimental, up to 60 min audio)',
        });
        new cdk.CfnOutput(this, 'NoChunkUploadCommand', {
            value: `aws s3 cp your-audio.wav s3://${bucket.bucketName}/${noChunkConfig.inputPrefix}`,
            description: 'Upload to no-chunk processing (experimental)',
        });
    }
    createParakeetService(config, vpc, cluster, bucket, logGroup, executionRole, taskRole, _lambdaSecurityGroup, parakeetModel, idPrefix, ecrRepoName, ecrImageTag) {
        // Determine memory/CPU based on instance type
        // Sized to allow 2 tasks per instance for rolling deployments
        const isP4d = config.instanceType.startsWith('p4d');
        const isG5 = config.instanceType.startsWith('g5');
        const isG4dn = config.instanceType.startsWith('g4dn');
        let memoryMiB = 15360; // default
        let cpu = 4096;
        if (isP4d) {
            // p4de.24xlarge: 1152GB RAM, 96 vCPU, 8x A100 GPUs
            // Use ~40% to allow 2 tasks
            memoryMiB = 450 * 1024; // 450GB (of 1152GB)
            cpu = 40 * 1024; // 40 vCPU (of 96)
        }
        else if (isG5) {
            // g5.4xlarge: 64GB RAM, 16 vCPU, 1x A10G GPU
            memoryMiB = 28 * 1024; // 28GB (of 64GB)
            cpu = 7 * 1024; // 7 vCPU (of 16)
        }
        else if (isG4dn) {
            // g4dn.2xlarge: 32GB RAM, 8 vCPU, 1x T4 GPU
            memoryMiB = 14 * 1024; // 14GB (of 32GB)
            cpu = 3 * 1024; // 3 vCPU (of 8)
        }
        // Add GPU EC2 capacity
        const autoScalingGroup = cluster.addCapacity(`${idPrefix}GpuCapacity`, {
            instanceType: new ec2.InstanceType(config.instanceType),
            machineImage: ecs.EcsOptimizedImage.amazonLinux2(ecs.AmiHardwareType.GPU),
            minCapacity: 2,
            maxCapacity: 2,
            desiredCapacity: 2,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            blockDevices: [
                {
                    deviceName: '/dev/xvda',
                    volume: autoscaling.BlockDeviceVolume.ebs(200, {
                        volumeType: autoscaling.EbsDeviceVolumeType.GP3,
                        deleteOnTermination: true,
                    }),
                },
            ],
        });
        // ECS Task Definition
        const taskDefinition = new ecs.Ec2TaskDefinition(this, `${idPrefix}Task`, {
            executionRole,
            taskRole,
            family: `parakeet-${config.serviceName}`,
            networkMode: ecs.NetworkMode.AWS_VPC,
        });
        // Container image: use ECR if provided, otherwise pull from NVIDIA NGC
        let containerImage;
        let containerCommand;
        if (ecrRepoName) {
            // Use pre-built ECR image (faster startup, no runtime pip install)
            const ecrRepo = ecr.Repository.fromRepositoryName(this, `${idPrefix}EcrRepo`, ecrRepoName);
            containerImage = ecs.ContainerImage.fromEcrRepository(ecrRepo, ecrImageTag || 'latest');
            containerCommand = undefined; // Dockerfile has CMD
        }
        else {
            // Pull from NVIDIA NGC and install deps at runtime
            // NeMo 24.09+ required for parakeet-*-0.6b-v2 models (use_bias parameter)
            containerImage = ecs.ContainerImage.fromRegistry('nvcr.io/nvidia/nemo:24.09');
            containerCommand = [
                'bash', '-c',
                'pip install boto3 grpcio grpcio-tools && ' +
                    'aws s3 cp s3://${S3_BUCKET}/scripts/transcribe_grpc.py /tmp/transcribe_grpc.py && ' +
                    'aws s3 cp s3://${S3_BUCKET}/scripts/transcribe.proto /tmp/transcribe.proto && ' +
                    'python -m grpc_tools.protoc -I/tmp --python_out=/tmp --grpc_python_out=/tmp /tmp/transcribe.proto && ' +
                    'cd /tmp && python transcribe_grpc.py',
            ];
        }
        // Container with gRPC server
        taskDefinition.addContainer('parakeet', {
            image: containerImage,
            memoryLimitMiB: memoryMiB,
            cpu,
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: `parakeet-${config.serviceName}`,
                logGroup,
            }),
            environment: {
                PARAKEET_MODEL: parakeetModel,
                S3_BUCKET: bucket.bucketName,
                AWS_DEFAULT_REGION: this.region,
                GRPC_PORT: '50051',
                PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True',
                CHUNK_DURATION: config.chunkDurationSeconds.toString(),
                MAX_AUDIO_DURATION_MINUTES: config.maxAudioDurationMinutes.toString(),
            },
            gpuCount: 1,
            ...(containerCommand && { command: containerCommand }),
            portMappings: [{ containerPort: 50051 }],
            // NeMo recommended settings for better GPU memory handling
            linuxParameters: new ecs.LinuxParameters(this, `${idPrefix}LinuxParams`, {
                sharedMemorySize: 2048, // 2GB shared memory (vs default 64MB)
            }),
            ulimits: [
                {
                    name: ecs.UlimitName.MEMLOCK,
                    softLimit: -1,
                    hardLimit: -1,
                },
                {
                    name: ecs.UlimitName.STACK,
                    softLimit: 67108864,
                    hardLimit: 67108864,
                },
            ],
        });
        // Security group for ECS service
        const serviceSecurityGroup = new ec2.SecurityGroup(this, `${idPrefix}ServiceSG`, {
            vpc,
            description: `Security group for Parakeet ${config.serviceName} gRPC service`,
            allowAllOutbound: true,
        });
        // NLB doesn't have security groups - traffic comes from NLB IPs in VPC
        // Allow gRPC traffic from anywhere in VPC (NLB health checks + Lambda via NLB)
        serviceSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(50051), 'Allow gRPC from VPC (NLB + Lambda)');
        // Internal NLB for gRPC (better performance than ALB for gRPC)
        const nlb = new elbv2.NetworkLoadBalancer(this, `${idPrefix}Nlb`, {
            vpc,
            internetFacing: false,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        });
        // ECS Service - depends on ASG to ensure instance is ready
        const service = new ecs.Ec2Service(this, `${idPrefix}Service`, {
            cluster,
            taskDefinition,
            desiredCount: 1,
            securityGroups: [serviceSecurityGroup],
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        });
        // Ensure EC2 instance is provisioned before ECS service tries to place tasks
        service.node.addDependency(autoScalingGroup);
        // Target group for gRPC (TCP)
        // Model loading takes 2-5 minutes, so we need generous health check settings
        const targetGroup = new elbv2.NetworkTargetGroup(this, `${idPrefix}TargetGroup`, {
            vpc,
            port: 50051,
            protocol: elbv2.Protocol.TCP,
            targets: [service.loadBalancerTarget({
                    containerName: 'parakeet',
                    containerPort: 50051,
                })],
            healthCheck: {
                protocol: elbv2.Protocol.TCP,
                interval: cdk.Duration.seconds(30),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 10, // Allow ~5 min for model loading (10 * 30s)
            },
            deregistrationDelay: cdk.Duration.seconds(30),
        });
        // NLB listener for gRPC
        nlb.addListener(`${idPrefix}GrpcListener`, {
            port: 50051,
            protocol: elbv2.Protocol.TCP,
            defaultTargetGroups: [targetGroup],
        });
        return { nlb, service };
    }
}
exports.ParakeetPocStack = ParakeetPocStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGFyYWtlZXQtcG9jLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vbGliL3BhcmFrZWV0LXBvYy1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFDbkMsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsMkRBQTJEO0FBQzNELHlDQUF5QztBQUN6QywyQ0FBMkM7QUFDM0MsNkNBQTZDO0FBQzdDLGlEQUFpRDtBQUNqRCx3REFBd0Q7QUFDeEQsMERBQTBEO0FBQzFELGdFQUFnRTtBQW1CaEUsTUFBYSxnQkFBaUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQUM3QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTRCO1FBQ3BFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLG9EQUFvRDtRQUNwRCxNQUFNLGNBQWMsR0FBMEI7WUFDNUMsWUFBWSxFQUFFLGNBQWM7WUFDNUIsb0JBQW9CLEVBQUUsRUFBRTtZQUN4Qix1QkFBdUIsRUFBRSxFQUFFO1lBQzNCLFdBQVcsRUFBRSxRQUFRO1lBQ3JCLFdBQVcsRUFBRSxVQUFVO1NBQ3hCLENBQUM7UUFFRiw0RkFBNEY7UUFDNUYsTUFBTSxhQUFhLEdBQTBCO1lBQzNDLCtDQUErQztZQUMvQyxZQUFZLEVBQUUsY0FBYztZQUM1QixvQkFBb0IsRUFBRSxFQUFFLEdBQUMsRUFBRSxFQUFHLDJCQUEyQjtZQUN6RCx1QkFBdUIsRUFBRSxFQUFFLEVBQUcsNkNBQTZDO1lBQzNFLFdBQVcsRUFBRSxnQkFBZ0I7WUFDN0IsV0FBVyxFQUFFLFVBQVU7U0FDeEIsQ0FBQztRQUVGLHNCQUFzQjtRQUN0QixNQUFNLEdBQUcsR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLEVBQUUsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFD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Z0IsQ0FBQyxDQUFDO1FBRTdDLDhCQUE4QjtRQUM5Qiw2RUFBNkU7UUFDN0UsTUFBTSxXQUFXLEdBQUcsSUFBSSxLQUFLLENBQUMsa0JBQWtCLENBQUMsSUFBSSxFQUFFLEdBQUcsUUFBUSxhQUFhLEVBQUU7WUFDL0UsR0FBRztZQUNILElBQUksRUFBRSxLQUFLO1lBQ1gsUUFBUSxFQUFFLEtBQUssQ0FBQyxRQUFRLENBQUMsR0FBRztZQUM1QixPQUFPLEVBQUUsQ0FBQyxPQUFPLENBQUMsa0JBQWtCLENBQUM7b0JBQ25DLGFBQWEsRUFBRSxVQUFVO29CQUN6QixhQUFhLEVBQUUsS0FBSztpQkFDckIsQ0FBQyxDQUFDO1lBQ0gsV0FBVyxFQUFFO2dCQUNYLFFBQVEsRUFBRSxLQUFLLENBQUMsUUFBUSxDQUFDLEdBQUc7Z0JBQzVCLFFBQVEsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7Z0JBQ2xDLHFCQUFxQixFQUFFLENBQUM7Z0JBQ3hCLHVCQUF1QixFQUFFLEVBQUUsRUFBRyw0Q0FBNEM7YUFDM0U7WUFDRCxtQkFBbUIsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7U0FDOUMsQ0FBQyxDQUFDO1FBRUgsd0JBQXdCO1FBQ3hCLEdBQUcsQ0FBQyxXQUFXLENBQUMsR0FBRyxRQUFRLGNBQWMsRUFBRTtZQUN6QyxJQUFJLEVBQUUsS0FBSztZQUNYLFFBQVEsRUFBRSxLQUFLLENBQUMsUUFBUSxDQUFDLEdBQUc7WUFDNUIsbUJBQW1CLEVBQUUsQ0FBQyxXQUFXLENBQUM7U0FDbkMsQ0FBQyxDQUFDO1FBRUgsT0FBTyxFQUFFLEdBQUcsRUFBRSxPQUFPLEVBQUUsQ0FBQztJQUMxQixDQUFDO0NBQ0Y7QUFsV0QsNENBa1dDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGVjMiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWMyJztcbmltcG9ydCAqIGFzIGVjcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNzJztcbmltcG9ydCAqIGFzIGVjciBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNyJztcbmltcG9ydCAqIGFzIGF1dG9zY2FsaW5nIGZyb20gJ2F3cy1jZGstbGliL2F3cy1hdXRvc2NhbGluZyc7XG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgKiBhcyBzM24gZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzLW5vdGlmaWNhdGlvbnMnO1xuaW1wb3J0ICogYXMgczNkZXBsb3kgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzLWRlcGxveW1lbnQnO1xuaW1wb3J0ICogYXMgZWxidjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVsYXN0aWNsb2FkYmFsYW5jaW5ndjInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5cbmludGVyZmFjZSBQYXJha2VldFNlcnZpY2VDb25maWcge1xuICBpbnN0YW5jZVR5cGU6IHN0cmluZztcbiAgY2h1bmtEdXJhdGlvblNlY29uZHM6IG51bWJlcjtcbiAgbWF4QXVkaW9EdXJhdGlvbk1pbnV0ZXM6IG51bWJlcjtcbiAgaW5wdXRQcmVmaXg6IHN0cmluZztcbiAgc2VydmljZU5hbWU6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFBhcmFrZWV0UG9jU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgdnBjSWQ6IHN0cmluZztcbiAgcGFyYWtlZXRNb2RlbDogc3RyaW5nO1xuICAvLyBPcHRpb25hbDogdXNlIGN1c3RvbSBFQ1IgaW1hZ2UgaW5zdGVhZCBvZiBwdWxsaW5nIGZyb20gTlZJRElBIE5HQ1xuICBlY3JSZXBvTmFtZT86IHN0cmluZztcbiAgZWNySW1hZ2VUYWc/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBQYXJha2VldFBvY1N0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IFBhcmFrZWV0UG9jU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gU2VydmljZSBjb25maWd1cmF0aW9ucyBmb3IgZHVhbC1wYXRoIGFyY2hpdGVjdHVyZVxuICAgIGNvbnN0IHN0YW5kYXJkQ29uZmlnOiBQYXJha2VldFNlcnZpY2VDb25maWcgPSB7XG4gICAgICBpbnN0YW5jZVR5cGU6ICdnNGRuLjJ4bGFyZ2UnLFxuICAgICAgY2h1bmtEdXJhdGlvblNlY29uZHM6IDMwLFxuICAgICAgbWF4QXVkaW9EdXJhdGlvbk1pbnV0ZXM6IDYwLFxuICAgICAgaW5wdXRQcmVmaXg6ICdpbnB1dC8nLFxuICAgICAgc2VydmljZU5hbWU6ICdzdGFuZGFyZCcsXG4gICAgfTtcblxuICAgIC8vIEV4cGVyaW1lbnRhbDogTm8gY2h1bmtpbmcgc2VydmljZSAocmVxdWlyZXMgbWFzc2l2ZSBHUFUgbWVtb3J5LCBsaW1pdGVkIHRvIH4xNSBtaW4gYXVkaW8pXG4gICAgY29uc3Qgbm9DaHVua0NvbmZpZzogUGFyYWtlZXRTZXJ2aWNlQ29uZmlnID0ge1xuICAgICAgLy8gaW5zdGFuY2VUeXBlOiAncDRkZS4yNHhsYXJnZScsICAvLyBBMTAwIDgwR0JcbiAgICAgIGluc3RhbmNlVHlwZTogJ2c0ZG4uMnhsYXJnZScsXG4gICAgICBjaHVua0R1cmF0aW9uU2Vjb25kczogNjAqMTAsICAvLyA2IGNodW5raW5nLCAxMCBtaW5zIGVhY2hcbiAgICAgIG1heEF1ZGlvRHVyYXRpb25NaW51dGVzOiA2MCwgIC8vIExpbWl0ZWQgdG8gfjYwIG1pbiBkdWUgdG8gVlJBTSBjb25zdHJhaW50c1xuICAgICAgaW5wdXRQcmVmaXg6ICdpbnB1dC1ub2NodW5rLycsXG4gICAgICBzZXJ2aWNlTmFtZTogJ25vLWNodW5rJyxcbiAgICB9O1xuXG4gICAgLy8gSW1wb3J0IGV4aXN0aW5nIFZQQ1xuICAgIGNvbnN0IHZwYyA9IGVjMi5WcGMuZnJvbUxvb2t1cCh0aGlzLCAnVnBjJywgeyB2cGNJZDogcHJvcHMudnBjSWQgfSk7XG5cbiAgICAvLyBTMyBidWNrZXQgZm9yIGF1ZGlvIGlucHV0LCB0cmFuc2NyaXB0IG91dHB1dCwgYW5kIHNjcmlwdHNcbiAgICBjb25zdCBidWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsICdBdWRpb0J1Y2tldCcsIHtcbiAgICAgIGJ1Y2tldE5hbWU6IGBwYXJha2VldC1wb2MtJHt0aGlzLmFjY291bnR9LSR7dGhpcy5yZWdpb259YCxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICBhdXRvRGVsZXRlT2JqZWN0czogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIFVwbG9hZCB0cmFuc2NyaWJlIHNjcmlwdCBhbmQgcHJvdG8gZmlsZXMgdG8gUzMgKGRlcGxveWVkIHZpYSBDREspXG4gICAgbmV3IHMzZGVwbG95LkJ1Y2tldERlcGxveW1lbnQodGhpcywgJ0RlcGxveVNjcmlwdCcsIHtcbiAgICAgIHNvdXJjZXM6IFtcbiAgICAgICAgczNkZXBsb3kuU291cmNlLmFzc2V0KCcuL3NjcmlwdHMnKSxcbiAgICAgICAgczNkZXBsb3kuU291cmNlLmFzc2V0KCcuL3Byb3RvJyksXG4gICAgICBdLFxuICAgICAgZGVzdGluYXRpb25CdWNrZXQ6IGJ1Y2tldCxcbiAgICAgIGRlc3RpbmF0aW9uS2V5UHJlZml4OiAnc2NyaXB0cycsXG4gICAgfSk7XG5cbiAgICAvLyBTaGFyZWQgRUNTIENsdXN0ZXJcbiAgICBjb25zdCBjbHVzdGVyID0gbmV3IGVjcy5DbHVzdGVyKHRoaXMsICdQYXJha2VldENsdXN0ZXInLCB7XG4gICAgICB2cGMsXG4gICAgICBjbHVzdGVyTmFtZTogJ3BhcmFrZWV0LXBvYy1jbHVzdGVyJyxcbiAgICB9KTtcblxuICAgIC8vIENsb3VkV2F0Y2ggTG9nIEdyb3VwIChzaGFyZWQpXG4gICAgY29uc3QgbG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCAnUGFyYWtlZXRMb2dzJywge1xuICAgICAgbG9nR3JvdXBOYW1lOiAnL2Vjcy9wYXJha2VldC1wb2MnLFxuICAgICAgcmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuT05FX1dFRUssXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgLy8gVGFzayBleGVjdXRpb24gcm9sZSAoc2hhcmVkKVxuICAgIGNvbnN0IGV4ZWN1dGlvblJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1Rhc2tFeGVjdXRpb25Sb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdzZXJ2aWNlLXJvbGUvQW1hem9uRUNTVGFza0V4ZWN1dGlvblJvbGVQb2xpY3knKSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICAvLyBUYXNrIHJvbGUgZm9yIFMzIGFjY2VzcyAoc2hhcmVkKVxuICAgIGNvbnN0IHRhc2tSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdUYXNrUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdlY3MtdGFza3MuYW1hem9uYXdzLmNvbScpLFxuICAgIH0pO1xuICAgIGJ1Y2tldC5ncmFudFJlYWRXcml0ZSh0YXNrUm9sZSk7XG5cbiAgICAvLyBMYW1iZGEgc2VjdXJpdHkgZ3JvdXAgKHNoYXJlZClcbiAgICBjb25zdCBsYW1iZGFTZWN1cml0eUdyb3VwID0gbmV3IGVjMi5TZWN1cml0eUdyb3VwKHRoaXMsICdMYW1iZGFTZWN1cml0eUdyb3VwJywge1xuICAgICAgdnBjLFxuICAgICAgZGVzY3JpcHRpb246ICdTZWN1cml0eSBncm91cCBmb3IgTGFtYmRhJyxcbiAgICAgIGFsbG93QWxsT3V0Ym91bmQ6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgYm90aCBzZXJ2aWNlcyB3aXRoIGdSUENcbiAgICBjb25zdCBzdGFuZGFyZFNlcnZpY2UgPSB0aGlzLmNyZWF0ZVBhcmFrZWV0U2VydmljZShcbiAgICAgIHN0YW5kYXJkQ29uZmlnLCB2cGMsIGNsdXN0ZXIsIGJ1Y2tldCwgbG9nR3JvdXAsIGV4ZWN1dGlvblJvbGUsIHRhc2tSb2xlLCBcbiAgICAgIGxhbWJkYVNlY3VyaXR5R3JvdXAsIHByb3BzLnBhcmFrZWV0TW9kZWwsICdTdGFuZGFyZCcsXG4gICAgICBwcm9wcy5lY3JSZXBvTmFtZSwgcHJvcHMuZWNySW1hZ2VUYWdcbiAgICApO1xuXG4gICAgY29uc3Qgbm9DaHVua1NlcnZpY2UgPSB0aGlzLmNyZWF0ZVBhcmFrZWV0U2VydmljZShcbiAgICAgIG5vQ2h1bmtDb25maWcsIHZwYywgY2x1c3RlciwgYnVja2V0LCBsb2dHcm91cCwgZXhlY3V0aW9uUm9sZSwgdGFza1JvbGUsXG4gICAgICBsYW1iZGFTZWN1cml0eUdyb3VwLCBwcm9wcy5wYXJha2VldE1vZGVsLCAnTm9DaHVuaycsXG4gICAgICBwcm9wcy5lY3JSZXBvTmFtZSwgcHJvcHMuZWNySW1hZ2VUYWdcbiAgICApO1xuXG4gICAgLy8gTGFtYmRhIGxheWVyIGZvciBnUlBDIGRlcGVuZGVuY2llc1xuICAgIGNvbnN0IGdycGNMYXllciA9IG5ldyBsYW1iZGEuTGF5ZXJWZXJzaW9uKHRoaXMsICdHcnBjTGF5ZXInLCB7XG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoJy4vbGFtYmRhLWxheWVyJyksXG4gICAgICBjb21wYXRpYmxlUnVudGltZXM6IFtsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMl0sXG4gICAgICBkZXNjcmlwdGlvbjogJ2dSUEMgYW5kIHByb3RvYnVmIGRlcGVuZGVuY2llcyBmb3IgTGFtYmRhJyxcbiAgICB9KTtcblxuICAgIC8vIExhbWJkYSB0byB0cmlnZ2VyIHRyYW5zY3JpcHRpb24gdmlhIGdSUEMgKHJvdXRlcyBiYXNlZCBvbiBwcmVmaXgpXG4gICAgY29uc3QgdHJpZ2dlckxhbWJkYSA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ1RyaWdnZXJMYW1iZGEnLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMixcbiAgICAgIGhhbmRsZXI6ICdpbmRleF9ncnBjLmhhbmRsZXInLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KCcuL2xhbWJkYScpLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMTUpLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgdnBjLFxuICAgICAgdnBjU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTIH0sXG4gICAgICBzZWN1cml0eUdyb3VwczogW2xhbWJkYVNlY3VyaXR5R3JvdXBdLFxuICAgICAgbGF5ZXJzOiBbZ3JwY0xheWVyXSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFNUQU5EQVJEX1NFUlZJQ0VfSE9TVDogc3RhbmRhcmRTZXJ2aWNlLm5sYi5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgICBTVEFOREFSRF9TRVJWSUNFX1BPUlQ6ICc1MDA1MScsXG4gICAgICAgIE5PX0NIVU5LX1NFUlZJQ0VfSE9TVDogbm9DaHVua1NlcnZpY2UubmxiLmxvYWRCYWxhbmNlckRuc05hbWUsXG4gICAgICAgIE5PX0NIVU5LX1NFUlZJQ0VfUE9SVDogJzUwMDUxJyxcbiAgICAgICAgUzNfQlVDS0VUOiBidWNrZXQuYnVja2V0TmFtZSxcbiAgICAgICAgU1RBTkRBUkRfUFJFRklYOiBzdGFuZGFyZENvbmZpZy5pbnB1dFByZWZpeCxcbiAgICAgICAgTk9fQ0hVTktfUFJFRklYOiBub0NodW5rQ29uZmlnLmlucHV0UHJlZml4LFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIFMzIHRyaWdnZXJzIGZvciBzdGFuZGFyZCBhdWRpbyAoaW5wdXQvKVxuICAgIGJ1Y2tldC5hZGRFdmVudE5vdGlmaWNhdGlvbihcbiAgICAgIHMzLkV2ZW50VHlwZS5PQkpFQ1RfQ1JFQVRFRCxcbiAgICAgIG5ldyBzM24uTGFtYmRhRGVzdGluYXRpb24odHJpZ2dlckxhbWJkYSksXG4gICAgICB7IHByZWZpeDogc3RhbmRhcmRDb25maWcuaW5wdXRQcmVmaXgsIHN1ZmZpeDogJy53YXYnIH0sXG4gICAgKTtcbiAgICBidWNrZXQuYWRkRXZlbnROb3RpZmljYXRpb24oXG4gICAgICBzMy5FdmVudFR5cGUuT0JKRUNUX0NSRUFURUQsXG4gICAgICBuZXcgczNuLkxhbWJkYURlc3RpbmF0aW9uKHRyaWdnZXJMYW1iZGEpLFxuICAgICAgeyBwcmVmaXg6IHN0YW5kYXJkQ29uZmlnLmlucHV0UHJlZml4LCBzdWZmaXg6ICcubXAzJyB9LFxuICAgICk7XG5cbiAgICAvLyBTMyB0cmlnZ2VycyBmb3Igbm8tY2h1bmsgYXVkaW8gKGlucHV0LW5vY2h1bmsvKVxuICAgIGJ1Y2tldC5hZGRFdmVudE5vdGlmaWNhdGlvbihcbiAgICAgIHMzLkV2ZW50VHlwZS5PQkpFQ1RfQ1JFQVRFRCxcbiAgICAgIG5ldyBzM24uTGFtYmRhRGVzdGluYXRpb24odHJpZ2dlckxhbWJkYSksXG4gICAgICB7IHByZWZpeDogbm9DaHVua0NvbmZpZy5pbnB1dFByZWZpeCwgc3VmZml4OiAnLndhdicgfSxcbiAgICApO1xuICAgIGJ1Y2tldC5hZGRFdmVudE5vdGlmaWNhdGlvbihcbiAgICAgIHMzLkV2ZW50VHlwZS5PQkpFQ1RfQ1JFQVRFRCxcbiAgICAgIG5ldyBzM24uTGFtYmRhRGVzdGluYXRpb24odHJpZ2dlckxhbWJkYSksXG4gICAgICB7IHByZWZpeDogbm9DaHVua0NvbmZpZy5pbnB1dFByZWZpeCwgc3VmZml4OiAnLm1wMycgfSxcbiAgICApO1xuXG4gICAgLy8gT3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdCdWNrZXROYW1lJywgeyB2YWx1ZTogYnVja2V0LmJ1Y2tldE5hbWUgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1N0YW5kYXJkU2VydmljZUhvc3QnLCB7IFxuICAgICAgdmFsdWU6IHN0YW5kYXJkU2VydmljZS5ubGIubG9hZEJhbGFuY2VyRG5zTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU3RhbmRhcmQgZ1JQQyBzZXJ2aWNlICgzMHMgY2h1bmtzLCB1cCB0byA2MCBtaW4gYXVkaW8pJyxcbiAgICB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnU3RhbmRhcmRVcGxvYWRDb21tYW5kJywge1xuICAgICAgdmFsdWU6IGBhd3MgczMgY3AgeW91ci1hdWRpby53YXYgczM6Ly8ke2J1Y2tldC5idWNrZXROYW1lfS8ke3N0YW5kYXJkQ29uZmlnLmlucHV0UHJlZml4fWAsXG4gICAgICBkZXNjcmlwdGlvbjogJ1VwbG9hZCB0byBzdGFuZGFyZCBwcm9jZXNzaW5nJyxcbiAgICB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTm9DaHVua1NlcnZpY2VIb3N0Jywge1xuICAgICAgdmFsdWU6IG5vQ2h1bmtTZXJ2aWNlLm5sYi5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdOby1jaHVuayBnUlBDIHNlcnZpY2UgKGV4cGVyaW1lbnRhbCwgdXAgdG8gNjAgbWluIGF1ZGlvKScsXG4gICAgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ05vQ2h1bmtVcGxvYWRDb21tYW5kJywge1xuICAgICAgdmFsdWU6IGBhd3MgczMgY3AgeW91ci1hdWRpby53YXYgczM6Ly8ke2J1Y2tldC5idWNrZXROYW1lfS8ke25vQ2h1bmtDb25maWcuaW5wdXRQcmVmaXh9YCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVXBsb2FkIHRvIG5vLWNodW5rIHByb2Nlc3NpbmcgKGV4cGVyaW1lbnRhbCknLFxuICAgIH0pO1xuICB9XG5cblxuICBwcml2YXRlIGNyZWF0ZVBhcmFrZWV0U2VydmljZShcbiAgICBjb25maWc6IFBhcmFrZWV0U2VydmljZUNvbmZpZyxcbiAgICB2cGM6IGVjMi5JVnBjLFxuICAgIGNsdXN0ZXI6IGVjcy5DbHVzdGVyLFxuICAgIGJ1Y2tldDogczMuQnVja2V0LFxuICAgIGxvZ0dyb3VwOiBsb2dzLkxvZ0dyb3VwLFxuICAgIGV4ZWN1dGlvblJvbGU6IGlhbS5Sb2xlLFxuICAgIHRhc2tSb2xlOiBpYW0uUm9sZSxcbiAgICBfbGFtYmRhU2VjdXJpdHlHcm91cDogZWMyLlNlY3VyaXR5R3JvdXAsXG4gICAgcGFyYWtlZXRNb2RlbDogc3RyaW5nLFxuICAgIGlkUHJlZml4OiBzdHJpbmcsXG4gICAgZWNyUmVwb05hbWU/OiBzdHJpbmcsXG4gICAgZWNySW1hZ2VUYWc/OiBzdHJpbmcsXG4gICk6IHsgbmxiOiBlbGJ2Mi5OZXR3b3JrTG9hZEJhbGFuY2VyOyBzZXJ2aWNlOiBlY3MuRWMyU2VydmljZSB9IHtcbiAgICBcbiAgICAvLyBEZXRlcm1pbmUgbWVtb3J5L0NQVSBiYXNlZCBvbiBpbnN0YW5jZSB0eXBlXG4gICAgLy8gU2l6ZWQgdG8gYWxsb3cgMiB0YXNrcyBwZXIgaW5zdGFuY2UgZm9yIHJvbGxpbmcgZGVwbG95bWVudHNcbiAgICBjb25zdCBpc1A0ZCA9IGNvbmZpZy5pbnN0YW5jZVR5cGUuc3RhcnRzV2l0aCgncDRkJyk7XG4gICAgY29uc3QgaXNHNSA9IGNvbmZpZy5pbnN0YW5jZVR5cGUuc3RhcnRzV2l0aCgnZzUnKTtcbiAgICBjb25zdCBpc0c0ZG4gPSBjb25maWcuaW5zdGFuY2VUeXBlLnN0YXJ0c1dpdGgoJ2c0ZG4nKTtcbiAgICBcbiAgICBsZXQgbWVtb3J5TWlCID0gMTUzNjA7ICAvLyBkZWZhdWx0XG4gICAgbGV0IGNwdSA9IDQwOTY7XG4gICAgXG4gICAgaWYgKGlzUDRkKSB7XG4gICAgICAvLyBwNGRlLjI0eGxhcmdlOiAxMTUyR0IgUkFNLCA5NiB2Q1BVLCA4eCBBMTAwIEdQVXNcbiAgICAgIC8vIFVzZSB+NDAlIHRvIGFsbG93IDIgdGFza3NcbiAgICAgIG1lbW9yeU1pQiA9IDQ1MCAqIDEwMjQ7ICAvLyA0NTBHQiAob2YgMTE1MkdCKVxuICAgICAgY3B1ID0gNDAgKiAxMDI0OyAgICAgICAgIC8vIDQwIHZDUFUgKG9mIDk2KVxuICAgIH0gZWxzZSBpZiAoaXNHNSkge1xuICAgICAgLy8gZzUuNHhsYXJnZTogNjRHQiBSQU0sIDE2IHZDUFUsIDF4IEExMEcgR1BVXG4gICAgICBtZW1vcnlNaUIgPSAyOCAqIDEwMjQ7ICAgLy8gMjhHQiAob2YgNjRHQilcbiAgICAgIGNwdSA9IDcgKiAxMDI0OyAgICAgICAgICAvLyA3IHZDUFUgKG9mIDE2KVxuICAgIH0gZWxzZSBpZiAoaXNHNGRuKSB7XG4gICAgICAvLyBnNGRuLjJ4bGFyZ2U6IDMyR0IgUkFNLCA4IHZDUFUsIDF4IFQ0IEdQVVxuICAgICAgbWVtb3J5TWlCID0gMTQgKiAxMDI0OyAgIC8vIDE0R0IgKG9mIDMyR0IpXG4gICAgICBjcHUgPSAzICogMTAyNDsgICAgICAgICAgLy8gMyB2Q1BVIChvZiA4KVxuICAgIH1cblxuICAgIC8vIEFkZCBHUFUgRUMyIGNhcGFjaXR5XG4gICAgY29uc3QgYXV0b1NjYWxpbmdHcm91cCA9IGNsdXN0ZXIuYWRkQ2FwYWNpdHkoYCR7aWRQcmVmaXh9R3B1Q2FwYWNpdHlgLCB7XG4gICAgICBpbnN0YW5jZVR5cGU6IG5ldyBlYzIuSW5zdGFuY2VUeXBlKGNvbmZpZy5pbnN0YW5jZVR5cGUpLFxuICAgICAgbWFjaGluZUltYWdlOiBlY3MuRWNzT3B0aW1pemVkSW1hZ2UuYW1hem9uTGludXgyKGVjcy5BbWlIYXJkd2FyZVR5cGUuR1BVKSxcbiAgICAgIG1pbkNhcGFjaXR5OiAyLFxuICAgICAgbWF4Q2FwYWNpdHk6IDIsXG4gICAgICBkZXNpcmVkQ2FwYWNpdHk6IDIsXG4gICAgICB2cGNTdWJuZXRzOiB7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MgfSxcbiAgICAgIGJsb2NrRGV2aWNlczogW1xuICAgICAgICB7XG4gICAgICAgICAgZGV2aWNlTmFtZTogJy9kZXYveHZkYScsXG4gICAgICAgICAgdm9sdW1lOiBhdXRvc2NhbGluZy5CbG9ja0RldmljZVZvbHVtZS5lYnMoMjAwLCB7ICAvLyAyMDBHQiBmb3IgbGFyZ2UgTmVNbyBjb250YWluZXIgKH4xNUdCKVxuICAgICAgICAgICAgdm9sdW1lVHlwZTogYXV0b3NjYWxpbmcuRWJzRGV2aWNlVm9sdW1lVHlwZS5HUDMsXG4gICAgICAgICAgICBkZWxldGVPblRlcm1pbmF0aW9uOiB0cnVlLFxuICAgICAgICAgIH0pLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIC8vIEVDUyBUYXNrIERlZmluaXRpb25cbiAgICBjb25zdCB0YXNrRGVmaW5pdGlvbiA9IG5ldyBlY3MuRWMyVGFza0RlZmluaXRpb24odGhpcywgYCR7aWRQcmVmaXh9VGFza2AsIHtcbiAgICAgIGV4ZWN1dGlvblJvbGUsXG4gICAgICB0YXNrUm9sZSxcbiAgICAgIGZhbWlseTogYHBhcmFrZWV0LSR7Y29uZmlnLnNlcnZpY2VOYW1lfWAsXG4gICAgICBuZXR3b3JrTW9kZTogZWNzLk5ldHdvcmtNb2RlLkFXU19WUEMsXG4gICAgfSk7XG5cbiAgICAvLyBDb250YWluZXIgaW1hZ2U6IHVzZSBFQ1IgaWYgcHJvdmlkZWQsIG90aGVyd2lzZSBwdWxsIGZyb20gTlZJRElBIE5HQ1xuICAgIGxldCBjb250YWluZXJJbWFnZTogZWNzLkNvbnRhaW5lckltYWdlO1xuICAgIGxldCBjb250YWluZXJDb21tYW5kOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcbiAgICBcbiAgICBpZiAoZWNyUmVwb05hbWUpIHtcbiAgICAgIC8vIFVzZSBwcmUtYnVpbHQgRUNSIGltYWdlIChmYXN0ZXIgc3RhcnR1cCwgbm8gcnVudGltZSBwaXAgaW5zdGFsbClcbiAgICAgIGNvbnN0IGVjclJlcG8gPSBlY3IuUmVwb3NpdG9yeS5mcm9tUmVwb3NpdG9yeU5hbWUodGhpcywgYCR7aWRQcmVmaXh9RWNyUmVwb2AsIGVjclJlcG9OYW1lKTtcbiAgICAgIGNvbnRhaW5lckltYWdlID0gZWNzLkNvbnRhaW5lckltYWdlLmZyb21FY3JSZXBvc2l0b3J5KGVjclJlcG8sIGVjckltYWdlVGFnIHx8ICdsYXRlc3QnKTtcbiAgICAgIGNvbnRhaW5lckNvbW1hbmQgPSB1bmRlZmluZWQ7ICAvLyBEb2NrZXJmaWxlIGhhcyBDTURcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gUHVsbCBmcm9tIE5WSURJQSBOR0MgYW5kIGluc3RhbGwgZGVwcyBhdCBydW50aW1lXG4gICAgICAvLyBOZU1vIDI0LjA5KyByZXF1aXJlZCBmb3IgcGFyYWtlZXQtKi0wLjZiLXYyIG1vZGVscyAodXNlX2JpYXMgcGFyYW1ldGVyKVxuICAgICAgY29udGFpbmVySW1hZ2UgPSBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbVJlZ2lzdHJ5KCdudmNyLmlvL252aWRpYS9uZW1vOjI0LjA5Jyk7XG4gICAgICBjb250YWluZXJDb21tYW5kID0gW1xuICAgICAgICAnYmFzaCcsICctYycsXG4gICAgICAgICdwaXAgaW5zdGFsbCBib3RvMyBncnBjaW8gZ3JwY2lvLXRvb2xzICYmICcgK1xuICAgICAgICAnYXdzIHMzIGNwIHMzOi8vJHtTM19CVUNLRVR9L3NjcmlwdHMvdHJhbnNjcmliZV9ncnBjLnB5IC90bXAvdHJhbnNjcmliZV9ncnBjLnB5ICYmICcgK1xuICAgICAgICAnYXdzIHMzIGNwIHMzOi8vJHtTM19CVUNLRVR9L3NjcmlwdHMvdHJhbnNjcmliZS5wcm90byAvdG1wL3RyYW5zY3JpYmUucHJvdG8gJiYgJyArXG4gICAgICAgICdweXRob24gLW0gZ3JwY190b29scy5wcm90b2MgLUkvdG1wIC0tcHl0aG9uX291dD0vdG1wIC0tZ3JwY19weXRob25fb3V0PS90bXAgL3RtcC90cmFuc2NyaWJlLnByb3RvICYmICcgK1xuICAgICAgICAnY2QgL3RtcCAmJiBweXRob24gdHJhbnNjcmliZV9ncnBjLnB5JyxcbiAgICAgIF07XG4gICAgfVxuXG4gICAgLy8gQ29udGFpbmVyIHdpdGggZ1JQQyBzZXJ2ZXJcbiAgICB0YXNrRGVmaW5pdGlvbi5hZGRDb250YWluZXIoJ3BhcmFrZWV0Jywge1xuICAgICAgaW1hZ2U6IGNvbnRhaW5lckltYWdlLFxuICAgICAgbWVtb3J5TGltaXRNaUI6IG1lbW9yeU1pQixcbiAgICAgIGNwdSxcbiAgICAgIGxvZ2dpbmc6IGVjcy5Mb2dEcml2ZXJzLmF3c0xvZ3Moe1xuICAgICAgICBzdHJlYW1QcmVmaXg6IGBwYXJha2VldC0ke2NvbmZpZy5zZXJ2aWNlTmFtZX1gLFxuICAgICAgICBsb2dHcm91cCxcbiAgICAgIH0pLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgUEFSQUtFRVRfTU9ERUw6IHBhcmFrZWV0TW9kZWwsXG4gICAgICAgIFMzX0JVQ0tFVDogYnVja2V0LmJ1Y2tldE5hbWUsXG4gICAgICAgIEFXU19ERUZBVUxUX1JFR0lPTjogdGhpcy5yZWdpb24hLFxuICAgICAgICBHUlBDX1BPUlQ6ICc1MDA1MScsXG4gICAgICAgIFBZVE9SQ0hfQ1VEQV9BTExPQ19DT05GOiAnZXhwYW5kYWJsZV9zZWdtZW50czpUcnVlJyxcbiAgICAgICAgQ0hVTktfRFVSQVRJT046IGNvbmZpZy5jaHVua0R1cmF0aW9uU2Vjb25kcy50b1N0cmluZygpLFxuICAgICAgICBNQVhfQVVESU9fRFVSQVRJT05fTUlOVVRFUzogY29uZmlnLm1heEF1ZGlvRHVyYXRpb25NaW51dGVzLnRvU3RyaW5nKCksXG4gICAgICB9LFxuICAgICAgZ3B1Q291bnQ6IDEsXG4gICAgICAuLi4oY29udGFpbmVyQ29tbWFuZCAmJiB7IGNvbW1hbmQ6IGNvbnRhaW5lckNvbW1hbmQgfSksXG4gICAgICBwb3J0TWFwcGluZ3M6IFt7IGNvbnRhaW5lclBvcnQ6IDUwMDUxIH1dLFxuICAgICAgLy8gTmVNbyByZWNvbW1lbmRlZCBzZXR0aW5ncyBmb3IgYmV0dGVyIEdQVSBtZW1vcnkgaGFuZGxpbmdcbiAgICAgIGxpbnV4UGFyYW1ldGVyczogbmV3IGVjcy5MaW51eFBhcmFtZXRlcnModGhpcywgYCR7aWRQcmVmaXh9TGludXhQYXJhbXNgLCB7XG4gICAgICAgIHNoYXJlZE1lbW9yeVNpemU6IDIwNDgsICAvLyAyR0Igc2hhcmVkIG1lbW9yeSAodnMgZGVmYXVsdCA2NE1CKVxuICAgICAgfSksXG4gICAgICB1bGltaXRzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiBlY3MuVWxpbWl0TmFtZS5NRU1MT0NLLFxuICAgICAgICAgIHNvZnRMaW1pdDogLTEsXG4gICAgICAgICAgaGFyZExpbWl0OiAtMSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6IGVjcy5VbGltaXROYW1lLlNUQUNLLFxuICAgICAgICAgIHNvZnRMaW1pdDogNjcxMDg4NjQsXG4gICAgICAgICAgaGFyZExpbWl0OiA2NzEwODg2NCxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICAvLyBTZWN1cml0eSBncm91cCBmb3IgRUNTIHNlcnZpY2VcbiAgICBjb25zdCBzZXJ2aWNlU2VjdXJpdHlHcm91cCA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCBgJHtpZFByZWZpeH1TZXJ2aWNlU0dgLCB7XG4gICAgICB2cGMsXG4gICAgICBkZXNjcmlwdGlvbjogYFNlY3VyaXR5IGdyb3VwIGZvciBQYXJha2VldCAke2NvbmZpZy5zZXJ2aWNlTmFtZX0gZ1JQQyBzZXJ2aWNlYCxcbiAgICAgIGFsbG93QWxsT3V0Ym91bmQ6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBOTEIgZG9lc24ndCBoYXZlIHNlY3VyaXR5IGdyb3VwcyAtIHRyYWZmaWMgY29tZXMgZnJvbSBOTEIgSVBzIGluIFZQQ1xuICAgIC8vIEFsbG93IGdSUEMgdHJhZmZpYyBmcm9tIGFueXdoZXJlIGluIFZQQyAoTkxCIGhlYWx0aCBjaGVja3MgKyBMYW1iZGEgdmlhIE5MQilcbiAgICBzZXJ2aWNlU2VjdXJpdHlHcm91cC5hZGRJbmdyZXNzUnVsZShcbiAgICAgIGVjMi5QZWVyLmlwdjQodnBjLnZwY0NpZHJCbG9jayksXG4gICAgICBlYzIuUG9ydC50Y3AoNTAwNTEpLCBcbiAgICAgICdBbGxvdyBnUlBDIGZyb20gVlBDIChOTEIgKyBMYW1iZGEpJ1xuICAgICk7XG5cbiAgICAvLyBJbnRlcm5hbCBOTEIgZm9yIGdSUEMgKGJldHRlciBwZXJmb3JtYW5jZSB0aGFuIEFMQiBmb3IgZ1JQQylcbiAgICBjb25zdCBubGIgPSBuZXcgZWxidjIuTmV0d29ya0xvYWRCYWxhbmNlcih0aGlzLCBgJHtpZFByZWZpeH1ObGJgLCB7XG4gICAgICB2cGMsXG4gICAgICBpbnRlcm5ldEZhY2luZzogZmFsc2UsXG4gICAgICB2cGNTdWJuZXRzOiB7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MgfSxcbiAgICB9KTtcblxuICAgIC8vIEVDUyBTZXJ2aWNlIC0gZGVwZW5kcyBvbiBBU0cgdG8gZW5zdXJlIGluc3RhbmNlIGlzIHJlYWR5XG4gICAgY29uc3Qgc2VydmljZSA9IG5ldyBlY3MuRWMyU2VydmljZSh0aGlzLCBgJHtpZFByZWZpeH1TZXJ2aWNlYCwge1xuICAgICAgY2x1c3RlcixcbiAgICAgIHRhc2tEZWZpbml0aW9uLFxuICAgICAgZGVzaXJlZENvdW50OiAxLFxuICAgICAgc2VjdXJpdHlHcm91cHM6IFtzZXJ2aWNlU2VjdXJpdHlHcm91cF0sXG4gICAgICB2cGNTdWJuZXRzOiB7IHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MgfSxcbiAgICB9KTtcbiAgICBcbiAgICAvLyBFbnN1cmUgRUMyIGluc3RhbmNlIGlzIHByb3Zpc2lvbmVkIGJlZm9yZSBFQ1Mgc2VydmljZSB0cmllcyB0byBwbGFjZSB0YXNrc1xuICAgIHNlcnZpY2Uubm9kZS5hZGREZXBlbmRlbmN5KGF1dG9TY2FsaW5nR3JvdXApO1xuXG4gICAgLy8gVGFyZ2V0IGdyb3VwIGZvciBnUlBDIChUQ1ApXG4gICAgLy8gTW9kZWwgbG9hZGluZyB0YWtlcyAyLTUgbWludXRlcywgc28gd2UgbmVlZCBnZW5lcm91cyBoZWFsdGggY2hlY2sgc2V0dGluZ3NcbiAgICBjb25zdCB0YXJnZXRHcm91cCA9IG5ldyBlbGJ2Mi5OZXR3b3JrVGFyZ2V0R3JvdXAodGhpcywgYCR7aWRQcmVmaXh9VGFyZ2V0R3JvdXBgLCB7XG4gICAgICB2cGMsXG4gICAgICBwb3J0OiA1MDA1MSxcbiAgICAgIHByb3RvY29sOiBlbGJ2Mi5Qcm90b2NvbC5UQ1AsXG4gICAgICB0YXJnZXRzOiBbc2VydmljZS5sb2FkQmFsYW5jZXJUYXJnZXQoe1xuICAgICAgICBjb250YWluZXJOYW1lOiAncGFyYWtlZXQnLFxuICAgICAgICBjb250YWluZXJQb3J0OiA1MDA1MSxcbiAgICAgIH0pXSxcbiAgICAgIGhlYWx0aENoZWNrOiB7XG4gICAgICAgIHByb3RvY29sOiBlbGJ2Mi5Qcm90b2NvbC5UQ1AsXG4gICAgICAgIGludGVydmFsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogMixcbiAgICAgICAgdW5oZWFsdGh5VGhyZXNob2xkQ291bnQ6IDEwLCAgLy8gQWxsb3cgfjUgbWluIGZvciBtb2RlbCBsb2FkaW5nICgxMCAqIDMwcylcbiAgICAgIH0sXG4gICAgICBkZXJlZ2lzdHJhdGlvbkRlbGF5OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgfSk7XG5cbiAgICAvLyBOTEIgbGlzdGVuZXIgZm9yIGdSUENcbiAgICBubGIuYWRkTGlzdGVuZXIoYCR7aWRQcmVmaXh9R3JwY0xpc3RlbmVyYCwge1xuICAgICAgcG9ydDogNTAwNTEsXG4gICAgICBwcm90b2NvbDogZWxidjIuUHJvdG9jb2wuVENQLFxuICAgICAgZGVmYXVsdFRhcmdldEdyb3VwczogW3RhcmdldEdyb3VwXSxcbiAgICB9KTtcblxuICAgIHJldHVybiB7IG5sYiwgc2VydmljZSB9O1xuICB9XG59XG4iXX0=