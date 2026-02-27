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
            instanceType: 'g5.2xlarge',
            chunkDurationSeconds: 30,
            maxAudioDurationMinutes: 60,
            inputPrefix: 'input/',
            serviceName: 'standard',
            numWorkers: 11, // 2 workers × ~1.3GB = ~2.6GB GPU (A10G has 24GB)
        };
        // Long audio service with larger GPU for bigger chunks
        // g5.2xlarge has A10G (24GB VRAM) - can handle 60s chunks safely
        // T4 (16GB) can only handle 30s chunks due to model size (~13GB)
        const noChunkConfig = {
            // instanceType: 'p4de.24xlarge',  // A100 80GB
            // instanceType: 'g4dn.2xlarge',  // T4 16GB - use 30s chunks max
            instanceType: 'g5.2xlarge', // A10G 24GB - can handle 60s chunks
            chunkDurationSeconds: 60 * 10, // 600s chunks (safe for A10G 24GB)
            maxAudioDurationMinutes: 60,
            inputPrefix: 'input-nochunk/',
            serviceName: 'no-chunk',
            numWorkers: 2, // 2 workers for parallel processing
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
                s3deploy.Source.asset('./scripts', { exclude: ['__pycache__', '*.pyc'] }),
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
        // Task role for S3 access and CloudWatch metrics (shared)
        const taskRole = new iam.Role(this, 'TaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });
        bucket.grantReadWrite(taskRole);
        // Allow EMF metrics to be published to CloudWatch
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['cloudwatch:PutMetricData'],
            resources: ['*'],
            conditions: {
                StringEquals: {
                    'cloudwatch:namespace': 'Parakeet/ASR',
                },
            },
        }));
        // Lambda security group (shared)
        const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
            vpc,
            description: 'Security group for Lambda',
            allowAllOutbound: true,
        });
        // Create both services with gRPC
        const standardService = this.createParakeetService(standardConfig, vpc, cluster, bucket, logGroup, executionRole, taskRole, lambdaSecurityGroup, props.parakeetModel, 'Standard', props.ecrRepoName, props.ecrImageTag, props.ecrImageDigest);
        const noChunkService = this.createParakeetService(noChunkConfig, vpc, cluster, bucket, logGroup, executionRole, taskRole, lambdaSecurityGroup, props.parakeetModel, 'NoChunk', props.ecrRepoName, props.ecrImageTag, props.ecrImageDigest);
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
    createParakeetService(config, vpc, cluster, bucket, logGroup, executionRole, taskRole, _lambdaSecurityGroup, parakeetModel, idPrefix, ecrRepoName, ecrImageTag, ecrImageDigest) {
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
        // Security group for EC2 instances
        const instanceSecurityGroup = new ec2.SecurityGroup(this, `${idPrefix}InstanceSG`, {
            vpc,
            description: `Security group for Parakeet ${config.serviceName} EC2 instances`,
            allowAllOutbound: true,
        });
        // IAM role for EC2 instances
        const instanceRole = new iam.Role(this, `${idPrefix}InstanceRole`, {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
        });
        // User data script for ECS agent config
        const userData = ec2.UserData.forLinux();
        userData.addCommands('#!/bin/bash', 'set -e', '', '# Configure ECS agent', `echo ECS_CLUSTER=${cluster.clusterName} >> /etc/ecs/ecs.config`, 'echo ECS_ENABLE_GPU_SUPPORT=true >> /etc/ecs/ecs.config');
        // Launch Template for GPU instances
        const launchTemplate = new ec2.LaunchTemplate(this, `${idPrefix}LaunchTemplate`, {
            launchTemplateName: `parakeet-${config.serviceName}-gpu`,
            instanceType: new ec2.InstanceType(config.instanceType),
            machineImage: ecs.EcsOptimizedImage.amazonLinux2(ecs.AmiHardwareType.GPU),
            role: instanceRole,
            securityGroup: instanceSecurityGroup,
            userData,
            blockDevices: [
                {
                    deviceName: '/dev/xvda',
                    volume: ec2.BlockDeviceVolume.ebs(200, {
                        volumeType: ec2.EbsDeviceVolumeType.GP3,
                        deleteOnTermination: true,
                    }),
                },
            ],
        });
        // Auto Scaling Group using Launch Template
        const autoScalingGroup = new autoscaling.AutoScalingGroup(this, `${idPrefix}Asg`, {
            vpc,
            launchTemplate,
            minCapacity: 2,
            maxCapacity: 2,
            desiredCapacity: 2,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        });
        // Associate ASG with ECS cluster using Capacity Provider
        const capacityProvider = new ecs.AsgCapacityProvider(this, `${idPrefix}CapacityProvider`, {
            autoScalingGroup,
            capacityProviderName: `parakeet-${config.serviceName}-cp`,
            enableManagedScaling: false,
            enableManagedTerminationProtection: false,
        });
        cluster.addAsgCapacityProvider(capacityProvider);
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
            // Use digest if provided (triggers ECS update when image changes), otherwise use tag
            containerImage = ecrImageDigest
                ? ecs.ContainerImage.fromRegistry(`${ecrRepo.repositoryUri}@${ecrImageDigest}`)
                : ecs.ContainerImage.fromEcrRepository(ecrRepo, ecrImageTag || 'latest');
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
                USE_FP16: 'false', // Disabled - RNNT models have CUDA memory issues with FP16 on long sequences
                CHUNK_DURATION: config.chunkDurationSeconds.toString(),
                MAX_AUDIO_DURATION_MINUTES: config.maxAudioDurationMinutes.toString(),
                NUM_WORKERS: config.numWorkers.toString(), // Parallel worker processes
                WORKER_BATCH_SIZE: '2', // Load workers in batches to avoid RAM spike during startup
                // ASR model type detection: 'parakeet' for nvidia/* models, 'whisper' for openai/whisper* models
                ASR_MODEL_TYPE: parakeetModel.startsWith('openai/whisper') || parakeetModel.startsWith('whisper-') ? 'whisper' : 'parakeet',
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGFyYWtlZXQtcG9jLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vbGliL3BhcmFrZWV0LXBvYy1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFDbkMsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsMkRBQTJEO0FBQzNELHlDQUF5QztBQUN6QywyQ0FBMkM7QUFDM0MsNkNBQTZDO0FBQzdDLGlEQUFpRDtBQUNqRCx3REFBd0Q7QUFDeEQsMERBQTBEO0FBQzFELGdFQUFnRTtBQXVCaEUsTUFBYSxnQkFBaUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQUM3QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTRCO1FBQ3BFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLG9EQUFvRDtRQUNwRCxNQUFNLGNBQWMsR0FBMEI7WUFDNUMsWUFBWSxFQUFFLFlBQVk7WUFDMUIsb0JBQW9CLEVBQUUsRUFBRTtZQUN4Qix1QkFBdUIsRUFBRSxFQUFFO1lBQzNCLFdBQVcsRUFBRSxRQUFRO1lBQ3JCLFdBQVcsRUFBRSxVQUFVO1lBQ3ZCLFVBQVUsRUFBRSxFQUFFLEVBQUcsa0RBQWtEO1NBQ3BFLENBQUM7UUFFRix1REFBdUQ7UUFDdkQsaUVBQWlFO1FBQ2pFLGlFQUFpRTtRQUNqRSxNQUFNLGFBQWEsR0FBMEI7WUFDM0MsK0NBQStDO1lBQy9DLGlFQUFpRTtZQUNqRSxZQUFZLEVBQUUsWUFBWSxFQUFRLG9DQUFvQztZQUN0RSxvQkFBb0IsRUFBRSxFQUFFLEdBQUMsRUFBRSxFQUFVLG1DQUFtQztZQUN4RSx1QkFBdUIsRUFBRSxFQUFFO1lBQzNCLFdBQVcsRUFBRSxnQkFBZ0I7WUFDN0IsV0FBVyxFQUFFLFVBQVU7WUFDdkIsVUFBVSxFQUFFLENBQUMsRUFBRyxvQ0FBb0M7U0FDckQsQ0FBQztRQUVGLHNCQUFzQjtRQUN0QixNQUFN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T0FBTyxFQUFFLENBQUM7SUFDMUIsQ0FBQztDQUNGO0FBemFELDRDQXlhQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcyc7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgKiBhcyBhdXRvc2NhbGluZyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXV0b3NjYWxpbmcnO1xuaW1wb3J0ICogYXMgczMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgczNuIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMy1ub3RpZmljYXRpb25zJztcbmltcG9ydCAqIGFzIHMzZGVwbG95IGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMy1kZXBsb3ltZW50JztcbmltcG9ydCAqIGFzIGVsYnYyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuXG5pbnRlcmZhY2UgUGFyYWtlZXRTZXJ2aWNlQ29uZmlnIHtcbiAgaW5zdGFuY2VUeXBlOiBzdHJpbmc7XG4gIGNodW5rRHVyYXRpb25TZWNvbmRzOiBudW1iZXI7XG4gIG1heEF1ZGlvRHVyYXRpb25NaW51dGVzOiBudW1iZXI7XG4gIGlucHV0UHJlZml4OiBzdHJpbmc7XG4gIHNlcnZpY2VOYW1lOiBzdHJpbmc7XG4gIG51bVdvcmtlcnM6IG51bWJlcjsgIC8vIE51bWJlciBvZiBwYXJhbGxlbCB3b3JrZXIgcHJvY2Vzc2VzIChlYWNoIGxvYWRzIG1vZGVsIGNvcHkpXG59XG5cbmludGVyZmFjZSBQYXJha2VldFBvY1N0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIHZwY0lkOiBzdHJpbmc7XG4gIHBhcmFrZWV0TW9kZWw6IHN0cmluZztcbiAgLy8gT3B0aW9uYWw6IHVzZSBjdXN0b20gRUNSIGltYWdlIGluc3RlYWQgb2YgcHVsbGluZyBmcm9tIE5WSURJQSBOR0NcbiAgZWNyUmVwb05hbWU/OiBzdHJpbmc7XG4gIGVjckltYWdlVGFnPzogc3RyaW5nO1xuICAvLyBPcHRpb25hbDogaW1hZ2UgZGlnZXN0IHRvIGZvcmNlIEVDUyB0YXNrIHVwZGF0ZSB3aGVuIGltYWdlIGNoYW5nZXNcbiAgLy8gUGFzcyB0aGUgZGlnZXN0IGZyb20gRUNSIChlLmcuLCBzaGEyNTY6YWJjMTIzLi4uKSB0byB0cmlnZ2VyIHJvbGxpbmcgdXBkYXRlXG4gIGVjckltYWdlRGlnZXN0Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgUGFyYWtlZXRQb2NTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBQYXJha2VldFBvY1N0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIFNlcnZpY2UgY29uZmlndXJhdGlvbnMgZm9yIGR1YWwtcGF0aCBhcmNoaXRlY3R1cmVcbiAgICBjb25zdCBzdGFuZGFyZENvbmZpZzogUGFyYWtlZXRTZXJ2aWNlQ29uZmlnID0ge1xuICAgICAgaW5zdGFuY2VUeXBlOiAnZzUuMnhsYXJnZScsXG4gICAgICBjaHVua0R1cmF0aW9uU2Vjb25kczogMzAsXG4gICAgICBtYXhBdWRpb0R1cmF0aW9uTWludXRlczogNjAsXG4gICAgICBpbnB1dFByZWZpeDogJ2lucHV0LycsXG4gICAgICBzZXJ2aWNlTmFtZTogJ3N0YW5kYXJkJyxcbiAgICAgIG51bVdvcmtlcnM6IDExLCAgLy8gMiB3b3JrZXJzIMOXIH4xLjNHQiA9IH4yLjZHQiBHUFUgKEExMEcgaGFzIDI0R0IpXG4gICAgfTtcblxuICAgIC8vIExvbmcgYXVkaW8gc2VydmljZSB3aXRoIGxhcmdlciBHUFUgZm9yIGJpZ2dlciBjaHVua3NcbiAgICAvLyBnNS4yeGxhcmdlIGhhcyBBMTBHICgyNEdCIFZSQU0pIC0gY2FuIGhhbmRsZSA2MHMgY2h1bmtzIHNhZmVseVxuICAgIC8vIFQ0ICgxNkdCKSBjYW4gb25seSBoYW5kbGUgMzBzIGNodW5rcyBkdWUgdG8gbW9kZWwgc2l6ZSAofjEzR0IpXG4gICAgY29uc3Qgbm9DaHVua0NvbmZpZzogUGFyYWtlZXRTZXJ2aWNlQ29uZmlnID0ge1xuICAgICAgLy8gaW5zdGFuY2VUeXBlOiAncDRkZS4yNHhsYXJnZScsICAvLyBBMTAwIDgwR0JcbiAgICAgIC8vIGluc3RhbmNlVHlwZTogJ2c0ZG4uMnhsYXJnZScsICAvLyBUNCAxNkdCIC0gdXNlIDMwcyBjaHVua3MgbWF4XG4gICAgICBpbnN0YW5jZVR5cGU6ICdnNS4yeGxhcmdlJywgICAgICAgLy8gQTEwRyAyNEdCIC0gY2FuIGhhbmRsZSA2MHMgY2h1bmtzXG4gICAgICBjaHVua0R1cmF0aW9uU2Vjb25kczogNjAqMTAsICAgICAgICAgLy8gNjAwcyBjaHVua3MgKHNhZmUgZm9yIEExMEcgMjRHQilcbiAgICAgIG1heEF1ZGlvRHVyYXRpb25NaW51dGVzOiA2MCxcbiAgICAgIGlucHV0UHJlZml4OiAnaW5wdXQtbm9jaHVuay8nLFxuICAgICAgc2VydmljZU5hbWU6ICduby1jaHVuaycsXG4gICAgICBudW1Xb3JrZXJzOiAyLCAgLy8gMiB3b3JrZXJzIGZvciBwYXJhbGxlbCBwcm9jZXNzaW5nXG4gICAgfTtcblxuICAgIC8vIEltcG9ydCBleGlzdGluZyBWUENcbiAgICBjb25zdCB2cGMgPSBlYzIuVnBjLmZyb21Mb29rdXAodGhpcywgJ1ZwYycsIHsgdnBjSWQ6IHByb3BzLnZwY0lkIH0pO1xuXG4gICAgLy8gUzMgYnVja2V0IGZvciBhdWRpbyBpbnB1dCwgdHJhbnNjcmlwdCBvdXRwdXQsIGFuZCBzY3JpcHRzXG4gICAgY29uc3QgYnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCAnQXVkaW9CdWNrZXQnLCB7XG4gICAgICBidWNrZXROYW1lOiBgcGFyYWtlZXQtcG9jLSR7dGhpcy5hY2NvdW50fS0ke3RoaXMucmVnaW9ufWAsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBVcGxvYWQgdHJhbnNjcmliZSBzY3JpcHQgYW5kIHByb3RvIGZpbGVzIHRvIFMzIChkZXBsb3llZCB2aWEgQ0RLKVxuICAgIG5ldyBzM2RlcGxveS5CdWNrZXREZXBsb3ltZW50KHRoaXMsICdEZXBsb3lTY3JpcHQnLCB7XG4gICAgICBzb3VyY2VzOiBbXG4gICAgICAgIHMzZGVwbG95LlNvdXJjZS5hc3NldCgnLi9zY3JpcHRzJywgeyBleGNsdWRlOiBbJ19fcHljYWNoZV9fJywgJyoucHljJ10gfSksXG4gICAgICAgIHMzZGVwbG95LlNvdXJjZS5hc3NldCgnLi9wcm90bycpLFxuICAgICAgXSxcbiAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiBidWNrZXQsXG4gICAgICBkZXN0aW5hdGlvbktleVByZWZpeDogJ3NjcmlwdHMnLFxuICAgIH0pO1xuXG4gICAgLy8gU2hhcmVkIEVDUyBDbHVzdGVyXG4gICAgY29uc3QgY2x1c3RlciA9IG5ldyBlY3MuQ2x1c3Rlcih0aGlzLCAnUGFyYWtlZXRDbHVzdGVyJywge1xuICAgICAgdnBjLFxuICAgICAgY2x1c3Rlck5hbWU6ICdwYXJha2VldC1wb2MtY2x1c3RlcicsXG4gICAgfSk7XG5cbiAgICAvLyBDbG91ZFdhdGNoIExvZyBHcm91cCAoc2hhcmVkKVxuICAgIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgJ1BhcmFrZWV0TG9ncycsIHtcbiAgICAgIGxvZ0dyb3VwTmFtZTogJy9lY3MvcGFyYWtlZXQtcG9jJyxcbiAgICAgIHJldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9XRUVLLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIC8vIFRhc2sgZXhlY3V0aW9uIHJvbGUgKHNoYXJlZClcbiAgICBjb25zdCBleGVjdXRpb25Sb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdUYXNrRXhlY3V0aW9uUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdlY3MtdGFza3MuYW1hem9uYXdzLmNvbScpLFxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZSgnc2VydmljZS1yb2xlL0FtYXpvbkVDU1Rhc2tFeGVjdXRpb25Sb2xlUG9saWN5JyksXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgLy8gVGFzayByb2xlIGZvciBTMyBhY2Nlc3MgYW5kIENsb3VkV2F0Y2ggbWV0cmljcyAoc2hhcmVkKVxuICAgIGNvbnN0IHRhc2tSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdUYXNrUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdlY3MtdGFza3MuYW1hem9uYXdzLmNvbScpLFxuICAgIH0pO1xuICAgIGJ1Y2tldC5ncmFudFJlYWRXcml0ZSh0YXNrUm9sZSk7XG4gICAgXG4gICAgLy8gQWxsb3cgRU1GIG1ldHJpY3MgdG8gYmUgcHVibGlzaGVkIHRvIENsb3VkV2F0Y2hcbiAgICB0YXNrUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ2Nsb3Vkd2F0Y2g6UHV0TWV0cmljRGF0YSddLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgIGNvbmRpdGlvbnM6IHtcbiAgICAgICAgU3RyaW5nRXF1YWxzOiB7XG4gICAgICAgICAgJ2Nsb3Vkd2F0Y2g6bmFtZXNwYWNlJzogJ1BhcmFrZWV0L0FTUicsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pKTtcblxuICAgIC8vIExhbWJkYSBzZWN1cml0eSBncm91cCAoc2hhcmVkKVxuICAgIGNvbnN0IGxhbWJkYVNlY3VyaXR5R3JvdXAgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ0xhbWJkYVNlY3VyaXR5R3JvdXAnLCB7XG4gICAgICB2cGMsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NlY3VyaXR5IGdyb3VwIGZvciBMYW1iZGEnLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBib3RoIHNlcnZpY2VzIHdpdGggZ1JQQ1xuICAgIGNvbnN0IHN0YW5kYXJkU2VydmljZSA9IHRoaXMuY3JlYXRlUGFyYWtlZXRTZXJ2aWNlKFxuICAgICAgc3RhbmRhcmRDb25maWcsIHZwYywgY2x1c3RlciwgYnVja2V0LCBsb2dHcm91cCwgZXhlY3V0aW9uUm9sZSwgdGFza1JvbGUsIFxuICAgICAgbGFtYmRhU2VjdXJpdHlHcm91cCwgcHJvcHMucGFyYWtlZXRNb2RlbCwgJ1N0YW5kYXJkJyxcbiAgICAgIHByb3BzLmVjclJlcG9OYW1lLCBwcm9wcy5lY3JJbWFnZVRhZywgcHJvcHMuZWNySW1hZ2VEaWdlc3RcbiAgICApO1xuXG4gICAgY29uc3Qgbm9DaHVua1NlcnZpY2UgPSB0aGlzLmNyZWF0ZVBhcmFrZWV0U2VydmljZShcbiAgICAgIG5vQ2h1bmtDb25maWcsIHZwYywgY2x1c3RlciwgYnVja2V0LCBsb2dHcm91cCwgZXhlY3V0aW9uUm9sZSwgdGFza1JvbGUsXG4gICAgICBsYW1iZGFTZWN1cml0eUdyb3VwLCBwcm9wcy5wYXJha2VldE1vZGVsLCAnTm9DaHVuaycsXG4gICAgICBwcm9wcy5lY3JSZXBvTmFtZSwgcHJvcHMuZWNySW1hZ2VUYWcsIHByb3BzLmVjckltYWdlRGlnZXN0XG4gICAgKTtcblxuICAgIC8vIExhbWJkYSBsYXllciBmb3IgZ1JQQyBkZXBlbmRlbmNpZXNcbiAgICBjb25zdCBncnBjTGF5ZXIgPSBuZXcgbGFtYmRhLkxheWVyVmVyc2lvbih0aGlzLCAnR3JwY0xheWVyJywge1xuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KCcuL2xhbWJkYS1sYXllcicpLFxuICAgICAgY29tcGF0aWJsZVJ1bnRpbWVzOiBbbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTJdLFxuICAgICAgZGVzY3JpcHRpb246ICdnUlBDIGFuZCBwcm90b2J1ZiBkZXBlbmRlbmNpZXMgZm9yIExhbWJkYScsXG4gICAgfSk7XG5cbiAgICAvLyBMYW1iZGEgdG8gdHJpZ2dlciB0cmFuc2NyaXB0aW9uIHZpYSBnUlBDIChyb3V0ZXMgYmFzZWQgb24gcHJlZml4KVxuICAgIGNvbnN0IHRyaWdnZXJMYW1iZGEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdUcmlnZ2VyTGFtYmRhJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTIsXG4gICAgICBoYW5kbGVyOiAnaW5kZXhfZ3JwYy5oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldCgnLi9sYW1iZGEnKSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDE1KSxcbiAgICAgIG1lbW9yeVNpemU6IDI1NixcbiAgICAgIHZwYyxcbiAgICAgIHZwY1N1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyB9LFxuICAgICAgc2VjdXJpdHlHcm91cHM6IFtsYW1iZGFTZWN1cml0eUdyb3VwXSxcbiAgICAgIGxheWVyczogW2dycGNMYXllcl0sXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBTVEFOREFSRF9TRVJWSUNFX0hPU1Q6IHN0YW5kYXJkU2VydmljZS5ubGIubG9hZEJhbGFuY2VyRG5zTmFtZSxcbiAgICAgICAgU1RBTkRBUkRfU0VSVklDRV9QT1JUOiAnNTAwNTEnLFxuICAgICAgICBOT19DSFVOS19TRVJWSUNFX0hPU1Q6IG5vQ2h1bmtTZXJ2aWNlLm5sYi5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgICBOT19DSFVOS19TRVJWSUNFX1BPUlQ6ICc1MDA1MScsXG4gICAgICAgIFMzX0JVQ0tFVDogYnVja2V0LmJ1Y2tldE5hbWUsXG4gICAgICAgIFNUQU5EQVJEX1BSRUZJWDogc3RhbmRhcmRDb25maWcuaW5wdXRQcmVmaXgsXG4gICAgICAgIE5PX0NIVU5LX1BSRUZJWDogbm9DaHVua0NvbmZpZy5pbnB1dFByZWZpeCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBTMyB0cmlnZ2VycyBmb3Igc3RhbmRhcmQgYXVkaW8gKGlucHV0LylcbiAgICBidWNrZXQuYWRkRXZlbnROb3RpZmljYXRpb24oXG4gICAgICBzMy5FdmVudFR5cGUuT0JKRUNUX0NSRUFURUQsXG4gICAgICBuZXcgczNuLkxhbWJkYURlc3RpbmF0aW9uKHRyaWdnZXJMYW1iZGEpLFxuICAgICAgeyBwcmVmaXg6IHN0YW5kYXJkQ29uZmlnLmlucHV0UHJlZml4LCBzdWZmaXg6ICcud2F2JyB9LFxuICAgICk7XG4gICAgYnVja2V0LmFkZEV2ZW50Tm90aWZpY2F0aW9uKFxuICAgICAgczMuRXZlbnRUeXBlLk9CSkVDVF9DUkVBVEVELFxuICAgICAgbmV3IHMzbi5MYW1iZGFEZXN0aW5hdGlvbih0cmlnZ2VyTGFtYmRhKSxcbiAgICAgIHsgcHJlZml4OiBzdGFuZGFyZENvbmZpZy5pbnB1dFByZWZpeCwgc3VmZml4OiAnLm1wMycgfSxcbiAgICApO1xuXG4gICAgLy8gUzMgdHJpZ2dlcnMgZm9yIG5vLWNodW5rIGF1ZGlvIChpbnB1dC1ub2NodW5rLylcbiAgICBidWNrZXQuYWRkRXZlbnROb3RpZmljYXRpb24oXG4gICAgICBzMy5FdmVudFR5cGUuT0JKRUNUX0NSRUFURUQsXG4gICAgICBuZXcgczNuLkxhbWJkYURlc3RpbmF0aW9uKHRyaWdnZXJMYW1iZGEpLFxuICAgICAgeyBwcmVmaXg6IG5vQ2h1bmtDb25maWcuaW5wdXRQcmVmaXgsIHN1ZmZpeDogJy53YXYnIH0sXG4gICAgKTtcbiAgICBidWNrZXQuYWRkRXZlbnROb3RpZmljYXRpb24oXG4gICAgICBzMy5FdmVudFR5cGUuT0JKRUNUX0NSRUFURUQsXG4gICAgICBuZXcgczNuLkxhbWJkYURlc3RpbmF0aW9uKHRyaWdnZXJMYW1iZGEpLFxuICAgICAgeyBwcmVmaXg6IG5vQ2h1bmtDb25maWcuaW5wdXRQcmVmaXgsIHN1ZmZpeDogJy5tcDMnIH0sXG4gICAgKTtcblxuICAgIC8vIE91dHB1dHNcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQnVja2V0TmFtZScsIHsgdmFsdWU6IGJ1Y2tldC5idWNrZXROYW1lIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdTdGFuZGFyZFNlcnZpY2VIb3N0JywgeyBcbiAgICAgIHZhbHVlOiBzdGFuZGFyZFNlcnZpY2UubmxiLmxvYWRCYWxhbmNlckRuc05hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ1N0YW5kYXJkIGdSUEMgc2VydmljZSAoMzBzIGNodW5rcywgdXAgdG8gNjAgbWluIGF1ZGlvKScsXG4gICAgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1N0YW5kYXJkVXBsb2FkQ29tbWFuZCcsIHtcbiAgICAgIHZhbHVlOiBgYXdzIHMzIGNwIHlvdXItYXVkaW8ud2F2IHMzOi8vJHtidWNrZXQuYnVja2V0TmFtZX0vJHtzdGFuZGFyZENvbmZpZy5pbnB1dFByZWZpeH1gLFxuICAgICAgZGVzY3JpcHRpb246ICdVcGxvYWQgdG8gc3RhbmRhcmQgcHJvY2Vzc2luZycsXG4gICAgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ05vQ2h1bmtTZXJ2aWNlSG9zdCcsIHtcbiAgICAgIHZhbHVlOiBub0NodW5rU2VydmljZS5ubGIubG9hZEJhbGFuY2VyRG5zTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnTm8tY2h1bmsgZ1JQQyBzZXJ2aWNlIChleHBlcmltZW50YWwsIHVwIHRvIDYwIG1pbiBhdWRpbyknLFxuICAgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdOb0NodW5rVXBsb2FkQ29tbWFuZCcsIHtcbiAgICAgIHZhbHVlOiBgYXdzIHMzIGNwIHlvdXItYXVkaW8ud2F2IHMzOi8vJHtidWNrZXQuYnVja2V0TmFtZX0vJHtub0NodW5rQ29uZmlnLmlucHV0UHJlZml4fWAsXG4gICAgICBkZXNjcmlwdGlvbjogJ1VwbG9hZCB0byBuby1jaHVuayBwcm9jZXNzaW5nIChleHBlcmltZW50YWwpJyxcbiAgICB9KTtcbiAgfVxuXG5cbiAgcHJpdmF0ZSBjcmVhdGVQYXJha2VldFNlcnZpY2UoXG4gICAgY29uZmlnOiBQYXJha2VldFNlcnZpY2VDb25maWcsXG4gICAgdnBjOiBlYzIuSVZwYyxcbiAgICBjbHVzdGVyOiBlY3MuQ2x1c3RlcixcbiAgICBidWNrZXQ6IHMzLkJ1Y2tldCxcbiAgICBsb2dHcm91cDogbG9ncy5Mb2dHcm91cCxcbiAgICBleGVjdXRpb25Sb2xlOiBpYW0uUm9sZSxcbiAgICB0YXNrUm9sZTogaWFtLlJvbGUsXG4gICAgX2xhbWJkYVNlY3VyaXR5R3JvdXA6IGVjMi5TZWN1cml0eUdyb3VwLFxuICAgIHBhcmFrZWV0TW9kZWw6IHN0cmluZyxcbiAgICBpZFByZWZpeDogc3RyaW5nLFxuICAgIGVjclJlcG9OYW1lPzogc3RyaW5nLFxuICAgIGVjckltYWdlVGFnPzogc3RyaW5nLFxuICAgIGVjckltYWdlRGlnZXN0Pzogc3RyaW5nLFxuICApOiB7IG5sYjogZWxidjIuTmV0d29ya0xvYWRCYWxhbmNlcjsgc2VydmljZTogZWNzLkVjMlNlcnZpY2UgfSB7XG4gICAgXG4gICAgLy8gRGV0ZXJtaW5lIG1lbW9yeS9DUFUgYmFzZWQgb24gaW5zdGFuY2UgdHlwZVxuICAgIC8vIFNpemVkIHRvIGFsbG93IDIgdGFza3MgcGVyIGluc3RhbmNlIGZvciByb2xsaW5nIGRlcGxveW1lbnRzXG4gICAgY29uc3QgaXNQNGQgPSBjb25maWcuaW5zdGFuY2VUeXBlLnN0YXJ0c1dpdGgoJ3A0ZCcpO1xuICAgIGNvbnN0IGlzRzUgPSBjb25maWcuaW5zdGFuY2VUeXBlLnN0YXJ0c1dpdGgoJ2c1Jyk7XG4gICAgY29uc3QgaXNHNGRuID0gY29uZmlnLmluc3RhbmNlVHlwZS5zdGFydHNXaXRoKCdnNGRuJyk7XG4gICAgXG4gICAgbGV0IG1lbW9yeU1pQiA9IDE1MzYwOyAgLy8gZGVmYXVsdFxuICAgIGxldCBjcHUgPSA0MDk2O1xuICAgIFxuICAgIGlmIChpc1A0ZCkge1xuICAgICAgLy8gcDRkZS4yNHhsYXJnZTogMTE1MkdCIFJBTSwgOTYgdkNQVSwgOHggQTEwMCBHUFVzXG4gICAgICAvLyBVc2UgfjQwJSB0byBhbGxvdyAyIHRhc2tzXG4gICAgICBtZW1vcnlNaUIgPSA0NTAgKiAxMDI0OyAgLy8gNDUwR0IgKG9mIDExNTJHQilcbiAgICAgIGNwdSA9IDQwICogMTAyNDsgICAgICAgICAvLyA0MCB2Q1BVIChvZiA5NilcbiAgICB9IGVsc2UgaWYgKGlzRzUpIHtcbiAgICAgIC8vIGc1LjR4bGFyZ2U6IDY0R0IgUkFNLCAxNiB2Q1BVLCAxeCBBMTBHIEdQVVxuICAgICAgbWVtb3J5TWlCID0gMjggKiAxMDI0OyAgIC8vIDI4R0IgKG9mIDY0R0IpXG4gICAgICBjcHUgPSA3ICogMTAyNDsgICAgICAgICAgLy8gNyB2Q1BVIChvZiAxNilcbiAgICB9IGVsc2UgaWYgKGlzRzRkbikge1xuICAgICAgLy8gZzRkbi4yeGxhcmdlOiAzMkdCIFJBTSwgOCB2Q1BVLCAxeCBUNCBHUFVcbiAgICAgIG1lbW9yeU1pQiA9IDE0ICogMTAyNDsgICAvLyAxNEdCIChvZiAzMkdCKVxuICAgICAgY3B1ID0gMyAqIDEwMjQ7ICAgICAgICAgIC8vIDMgdkNQVSAob2YgOClcbiAgICB9XG5cbiAgICAvLyBTZWN1cml0eSBncm91cCBmb3IgRUMyIGluc3RhbmNlc1xuICAgIGNvbnN0IGluc3RhbmNlU2VjdXJpdHlHcm91cCA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCBgJHtpZFByZWZpeH1JbnN0YW5jZVNHYCwge1xuICAgICAgdnBjLFxuICAgICAgZGVzY3JpcHRpb246IGBTZWN1cml0eSBncm91cCBmb3IgUGFyYWtlZXQgJHtjb25maWcuc2VydmljZU5hbWV9IEVDMiBpbnN0YW5jZXNgLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIC8vIElBTSByb2xlIGZvciBFQzIgaW5zdGFuY2VzXG4gICAgY29uc3QgaW5zdGFuY2VSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIGAke2lkUHJlZml4fUluc3RhbmNlUm9sZWAsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdlYzIuYW1hem9uYXdzLmNvbScpLFxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZSgnc2VydmljZS1yb2xlL0FtYXpvbkVDMkNvbnRhaW5lclNlcnZpY2Vmb3JFQzJSb2xlJyksXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZSgnQW1hem9uU1NNTWFuYWdlZEluc3RhbmNlQ29yZScpLFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIC8vIFVzZXIgZGF0YSBzY3JpcHQgZm9yIEVDUyBhZ2VudCBjb25maWdcbiAgICBjb25zdCB1c2VyRGF0YSA9IGVjMi5Vc2VyRGF0YS5mb3JMaW51eCgpO1xuICAgIHVzZXJEYXRhLmFkZENvbW1hbmRzKFxuICAgICAgJyMhL2Jpbi9iYXNoJyxcbiAgICAgICdzZXQgLWUnLFxuICAgICAgJycsXG4gICAgICAnIyBDb25maWd1cmUgRUNTIGFnZW50JyxcbiAgICAgIGBlY2hvIEVDU19DTFVTVEVSPSR7Y2x1c3Rlci5jbHVzdGVyTmFtZX0gPj4gL2V0Yy9lY3MvZWNzLmNvbmZpZ2AsXG4gICAgICAnZWNobyBFQ1NfRU5BQkxFX0dQVV9TVVBQT1JUPXRydWUgPj4gL2V0Yy9lY3MvZWNzLmNvbmZpZycsXG4gICAgKTtcblxuICAgIC8vIExhdW5jaCBUZW1wbGF0ZSBmb3IgR1BVIGluc3RhbmNlc1xuICAgIGNvbnN0IGxhdW5jaFRlbXBsYXRlID0gbmV3IGVjMi5MYXVuY2hUZW1wbGF0ZSh0aGlzLCBgJHtpZFByZWZpeH1MYXVuY2hUZW1wbGF0ZWAsIHtcbiAgICAgIGxhdW5jaFRlbXBsYXRlTmFtZTogYHBhcmFrZWV0LSR7Y29uZmlnLnNlcnZpY2VOYW1lfS1ncHVgLFxuICAgICAgaW5zdGFuY2VUeXBlOiBuZXcgZWMyLkluc3RhbmNlVHlwZShjb25maWcuaW5zdGFuY2VUeXBlKSxcbiAgICAgIG1hY2hpbmVJbWFnZTogZWNzLkVjc09wdGltaXplZEltYWdlLmFtYXpvbkxpbnV4MihlY3MuQW1pSGFyZHdhcmVUeXBlLkdQVSksXG4gICAgICByb2xlOiBpbnN0YW5jZVJvbGUsXG4gICAgICBzZWN1cml0eUdyb3VwOiBpbnN0YW5jZVNlY3VyaXR5R3JvdXAsXG4gICAgICB1c2VyRGF0YSxcbiAgICAgIGJsb2NrRGV2aWNlczogW1xuICAgICAgICB7XG4gICAgICAgICAgZGV2aWNlTmFtZTogJy9kZXYveHZkYScsXG4gICAgICAgICAgdm9sdW1lOiBlYzIuQmxvY2tEZXZpY2VWb2x1bWUuZWJzKDIwMCwge1xuICAgICAgICAgICAgdm9sdW1lVHlwZTogZWMyLkVic0RldmljZVZvbHVtZVR5cGUuR1AzLFxuICAgICAgICAgICAgZGVsZXRlT25UZXJtaW5hdGlvbjogdHJ1ZSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICAvLyBBdXRvIFNjYWxpbmcgR3JvdXAgdXNpbmcgTGF1bmNoIFRlbXBsYXRlXG4gICAgY29uc3QgYXV0b1NjYWxpbmdHcm91cCA9IG5ldyBhdXRvc2NhbGluZy5BdXRvU2NhbGluZ0dyb3VwKHRoaXMsIGAke2lkUHJlZml4fUFzZ2AsIHtcbiAgICAgIHZwYyxcbiAgICAgIGxhdW5jaFRlbXBsYXRlLFxuICAgICAgbWluQ2FwYWNpdHk6IDIsXG4gICAgICBtYXhDYXBhY2l0eTogMixcbiAgICAgIGRlc2lyZWRDYXBhY2l0eTogMixcbiAgICAgIHZwY1N1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyB9LFxuICAgIH0pO1xuXG4gICAgLy8gQXNzb2NpYXRlIEFTRyB3aXRoIEVDUyBjbHVzdGVyIHVzaW5nIENhcGFjaXR5IFByb3ZpZGVyXG4gICAgY29uc3QgY2FwYWNpdHlQcm92aWRlciA9IG5ldyBlY3MuQXNnQ2FwYWNpdHlQcm92aWRlcih0aGlzLCBgJHtpZFByZWZpeH1DYXBhY2l0eVByb3ZpZGVyYCwge1xuICAgICAgYXV0b1NjYWxpbmdHcm91cCxcbiAgICAgIGNhcGFjaXR5UHJvdmlkZXJOYW1lOiBgcGFyYWtlZXQtJHtjb25maWcuc2VydmljZU5hbWV9LWNwYCxcbiAgICAgIGVuYWJsZU1hbmFnZWRTY2FsaW5nOiBmYWxzZSxcbiAgICAgIGVuYWJsZU1hbmFnZWRUZXJtaW5hdGlvblByb3RlY3Rpb246IGZhbHNlLFxuICAgIH0pO1xuICAgIGNsdXN0ZXIuYWRkQXNnQ2FwYWNpdHlQcm92aWRlcihjYXBhY2l0eVByb3ZpZGVyKTtcblxuICAgIC8vIEVDUyBUYXNrIERlZmluaXRpb25cbiAgICBjb25zdCB0YXNrRGVmaW5pdGlvbiA9IG5ldyBlY3MuRWMyVGFza0RlZmluaXRpb24odGhpcywgYCR7aWRQcmVmaXh9VGFza2AsIHtcbiAgICAgIGV4ZWN1dGlvblJvbGUsXG4gICAgICB0YXNrUm9sZSxcbiAgICAgIGZhbWlseTogYHBhcmFrZWV0LSR7Y29uZmlnLnNlcnZpY2VOYW1lfWAsXG4gICAgICBuZXR3b3JrTW9kZTogZWNzLk5ldHdvcmtNb2RlLkFXU19WUEMsXG4gICAgfSk7XG5cbiAgICAvLyBDb250YWluZXIgaW1hZ2U6IHVzZSBFQ1IgaWYgcHJvdmlkZWQsIG90aGVyd2lzZSBwdWxsIGZyb20gTlZJRElBIE5HQ1xuICAgIGxldCBjb250YWluZXJJbWFnZTogZWNzLkNvbnRhaW5lckltYWdlO1xuICAgIGxldCBjb250YWluZXJDb21tYW5kOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcbiAgICBcbiAgICBpZiAoZWNyUmVwb05hbWUpIHtcbiAgICAgIC8vIFVzZSBwcmUtYnVpbHQgRUNSIGltYWdlIChmYXN0ZXIgc3RhcnR1cCwgbm8gcnVudGltZSBwaXAgaW5zdGFsbClcbiAgICAgIGNvbnN0IGVjclJlcG8gPSBlY3IuUmVwb3NpdG9yeS5mcm9tUmVwb3NpdG9yeU5hbWUodGhpcywgYCR7aWRQcmVmaXh9RWNyUmVwb2AsIGVjclJlcG9OYW1lKTtcbiAgICAgIC8vIFVzZSBkaWdlc3QgaWYgcHJvdmlkZWQgKHRyaWdnZXJzIEVDUyB1cGRhdGUgd2hlbiBpbWFnZSBjaGFuZ2VzKSwgb3RoZXJ3aXNlIHVzZSB0YWdcbiAgICAgIGNvbnRhaW5lckltYWdlID0gZWNySW1hZ2VEaWdlc3RcbiAgICAgICAgPyBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbVJlZ2lzdHJ5KGAke2VjclJlcG8ucmVwb3NpdG9yeVVyaX1AJHtlY3JJbWFnZURpZ2VzdH1gKVxuICAgICAgICA6IGVjcy5Db250YWluZXJJbWFnZS5mcm9tRWNyUmVwb3NpdG9yeShlY3JSZXBvLCBlY3JJbWFnZVRhZyB8fCAnbGF0ZXN0Jyk7XG4gICAgICBjb250YWluZXJDb21tYW5kID0gdW5kZWZpbmVkOyAgLy8gRG9ja2VyZmlsZSBoYXMgQ01EXG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIFB1bGwgZnJvbSBOVklESUEgTkdDIGFuZCBpbnN0YWxsIGRlcHMgYXQgcnVudGltZVxuICAgICAgLy8gTmVNbyAyNC4wOSsgcmVxdWlyZWQgZm9yIHBhcmFrZWV0LSotMC42Yi12MiBtb2RlbHMgKHVzZV9iaWFzIHBhcmFtZXRlcilcbiAgICAgIGNvbnRhaW5lckltYWdlID0gZWNzLkNvbnRhaW5lckltYWdlLmZyb21SZWdpc3RyeSgnbnZjci5pby9udmlkaWEvbmVtbzoyNC4wOScpO1xuICAgICAgY29udGFpbmVyQ29tbWFuZCA9IFtcbiAgICAgICAgJ2Jhc2gnLCAnLWMnLFxuICAgICAgICAncGlwIGluc3RhbGwgYm90bzMgZ3JwY2lvIGdycGNpby10b29scyAmJiAnICtcbiAgICAgICAgJ2F3cyBzMyBjcCBzMzovLyR7UzNfQlVDS0VUfS9zY3JpcHRzL3RyYW5zY3JpYmVfZ3JwYy5weSAvdG1wL3RyYW5zY3JpYmVfZ3JwYy5weSAmJiAnICtcbiAgICAgICAgJ2F3cyBzMyBjcCBzMzovLyR7UzNfQlVDS0VUfS9zY3JpcHRzL3RyYW5zY3JpYmUucHJvdG8gL3RtcC90cmFuc2NyaWJlLnByb3RvICYmICcgK1xuICAgICAgICAncHl0aG9uIC1tIGdycGNfdG9vbHMucHJvdG9jIC1JL3RtcCAtLXB5dGhvbl9vdXQ9L3RtcCAtLWdycGNfcHl0aG9uX291dD0vdG1wIC90bXAvdHJhbnNjcmliZS5wcm90byAmJiAnICtcbiAgICAgICAgJ2NkIC90bXAgJiYgcHl0aG9uIHRyYW5zY3JpYmVfZ3JwYy5weScsXG4gICAgICBdO1xuICAgIH1cblxuICAgIC8vIENvbnRhaW5lciB3aXRoIGdSUEMgc2VydmVyXG4gICAgdGFza0RlZmluaXRpb24uYWRkQ29udGFpbmVyKCdwYXJha2VldCcsIHtcbiAgICAgIGltYWdlOiBjb250YWluZXJJbWFnZSxcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiBtZW1vcnlNaUIsXG4gICAgICBjcHUsXG4gICAgICBsb2dnaW5nOiBlY3MuTG9nRHJpdmVycy5hd3NMb2dzKHtcbiAgICAgICAgc3RyZWFtUHJlZml4OiBgcGFyYWtlZXQtJHtjb25maWcuc2VydmljZU5hbWV9YCxcbiAgICAgICAgbG9nR3JvdXAsXG4gICAgICB9KSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFBBUkFLRUVUX01PREVMOiBwYXJha2VldE1vZGVsLFxuICAgICAgICBTM19CVUNLRVQ6IGJ1Y2tldC5idWNrZXROYW1lLFxuICAgICAgICBBV1NfREVGQVVMVF9SRUdJT046IHRoaXMucmVnaW9uISxcbiAgICAgICAgR1JQQ19QT1JUOiAnNTAwNTEnLFxuICAgICAgICBQWVRPUkNIX0NVREFfQUxMT0NfQ09ORjogJ2V4cGFuZGFibGVfc2VnbWVudHM6VHJ1ZScsXG4gICAgICAgIFVTRV9GUDE2OiAnZmFsc2UnLCAgLy8gRGlzYWJsZWQgLSBSTk5UIG1vZGVscyBoYXZlIENVREEgbWVtb3J5IGlzc3VlcyB3aXRoIEZQMTYgb24gbG9uZyBzZXF1ZW5jZXNcbiAgICAgICAgQ0hVTktfRFVSQVRJT046IGNvbmZpZy5jaHVua0R1cmF0aW9uU2Vjb25kcy50b1N0cmluZygpLFxuICAgICAgICBNQVhfQVVESU9fRFVSQVRJT05fTUlOVVRFUzogY29uZmlnLm1heEF1ZGlvRHVyYXRpb25NaW51dGVzLnRvU3RyaW5nKCksXG4gICAgICAgIE5VTV9XT1JLRVJTOiBjb25maWcubnVtV29ya2Vycy50b1N0cmluZygpLCAgLy8gUGFyYWxsZWwgd29ya2VyIHByb2Nlc3Nlc1xuICAgICAgICBXT1JLRVJfQkFUQ0hfU0laRTogJzInLCAgLy8gTG9hZCB3b3JrZXJzIGluIGJhdGNoZXMgdG8gYXZvaWQgUkFNIHNwaWtlIGR1cmluZyBzdGFydHVwXG4gICAgICAgIC8vIEFTUiBtb2RlbCB0eXBlIGRldGVjdGlvbjogJ3BhcmFrZWV0JyBmb3IgbnZpZGlhLyogbW9kZWxzLCAnd2hpc3BlcicgZm9yIG9wZW5haS93aGlzcGVyKiBtb2RlbHNcbiAgICAgICAgQVNSX01PREVMX1RZUEU6IHBhcmFrZWV0TW9kZWwuc3RhcnRzV2l0aCgnb3BlbmFpL3doaXNwZXInKSB8fCBwYXJha2VldE1vZGVsLnN0YXJ0c1dpdGgoJ3doaXNwZXItJykgPyAnd2hpc3BlcicgOiAncGFyYWtlZXQnLFxuICAgICAgfSxcbiAgICAgIGdwdUNvdW50OiAxLFxuICAgICAgLi4uKGNvbnRhaW5lckNvbW1hbmQgJiYgeyBjb21tYW5kOiBjb250YWluZXJDb21tYW5kIH0pLFxuICAgICAgcG9ydE1hcHBpbmdzOiBbeyBjb250YWluZXJQb3J0OiA1MDA1MSB9XSxcbiAgICAgIC8vIE5lTW8gcmVjb21tZW5kZWQgc2V0dGluZ3MgZm9yIGJldHRlciBHUFUgbWVtb3J5IGhhbmRsaW5nXG4gICAgICBsaW51eFBhcmFtZXRlcnM6IG5ldyBlY3MuTGludXhQYXJhbWV0ZXJzKHRoaXMsIGAke2lkUHJlZml4fUxpbnV4UGFyYW1zYCwge1xuICAgICAgICBzaGFyZWRNZW1vcnlTaXplOiAyMDQ4LCAgLy8gMkdCIHNoYXJlZCBtZW1vcnkgKHZzIGRlZmF1bHQgNjRNQilcbiAgICAgIH0pLFxuICAgICAgdWxpbWl0czogW1xuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogZWNzLlVsaW1pdE5hbWUuTUVNTE9DSyxcbiAgICAgICAgICBzb2Z0TGltaXQ6IC0xLFxuICAgICAgICAgIGhhcmRMaW1pdDogLTEsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiBlY3MuVWxpbWl0TmFtZS5TVEFDSyxcbiAgICAgICAgICBzb2Z0TGltaXQ6IDY3MTA4ODY0LFxuICAgICAgICAgIGhhcmRMaW1pdDogNjcxMDg4NjQsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgLy8gU2VjdXJpdHkgZ3JvdXAgZm9yIEVDUyBzZXJ2aWNlXG4gICAgY29uc3Qgc2VydmljZVNlY3VyaXR5R3JvdXAgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgYCR7aWRQcmVmaXh9U2VydmljZVNHYCwge1xuICAgICAgdnBjLFxuICAgICAgZGVzY3JpcHRpb246IGBTZWN1cml0eSBncm91cCBmb3IgUGFyYWtlZXQgJHtjb25maWcuc2VydmljZU5hbWV9IGdSUEMgc2VydmljZWAsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gTkxCIGRvZXNuJ3QgaGF2ZSBzZWN1cml0eSBncm91cHMgLSB0cmFmZmljIGNvbWVzIGZyb20gTkxCIElQcyBpbiBWUENcbiAgICAvLyBBbGxvdyBnUlBDIHRyYWZmaWMgZnJvbSBhbnl3aGVyZSBpbiBWUEMgKE5MQiBoZWFsdGggY2hlY2tzICsgTGFtYmRhIHZpYSBOTEIpXG4gICAgc2VydmljZVNlY3VyaXR5R3JvdXAuYWRkSW5ncmVzc1J1bGUoXG4gICAgICBlYzIuUGVlci5pcHY0KHZwYy52cGNDaWRyQmxvY2spLFxuICAgICAgZWMyLlBvcnQudGNwKDUwMDUxKSwgXG4gICAgICAnQWxsb3cgZ1JQQyBmcm9tIFZQQyAoTkxCICsgTGFtYmRhKSdcbiAgICApO1xuXG4gICAgLy8gSW50ZXJuYWwgTkxCIGZvciBnUlBDIChiZXR0ZXIgcGVyZm9ybWFuY2UgdGhhbiBBTEIgZm9yIGdSUEMpXG4gICAgY29uc3QgbmxiID0gbmV3IGVsYnYyLk5ldHdvcmtMb2FkQmFsYW5jZXIodGhpcywgYCR7aWRQcmVmaXh9TmxiYCwge1xuICAgICAgdnBjLFxuICAgICAgaW50ZXJuZXRGYWNpbmc6IGZhbHNlLFxuICAgICAgdnBjU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTIH0sXG4gICAgfSk7XG5cbiAgICAvLyBFQ1MgU2VydmljZSAtIGRlcGVuZHMgb24gQVNHIHRvIGVuc3VyZSBpbnN0YW5jZSBpcyByZWFkeVxuICAgIGNvbnN0IHNlcnZpY2UgPSBuZXcgZWNzLkVjMlNlcnZpY2UodGhpcywgYCR7aWRQcmVmaXh9U2VydmljZWAsIHtcbiAgICAgIGNsdXN0ZXIsXG4gICAgICB0YXNrRGVmaW5pdGlvbixcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiBbc2VydmljZVNlY3VyaXR5R3JvdXBdLFxuICAgICAgdnBjU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTIH0sXG4gICAgfSk7XG4gICAgXG4gICAgLy8gRW5zdXJlIEVDMiBpbnN0YW5jZSBpcyBwcm92aXNpb25lZCBiZWZvcmUgRUNTIHNlcnZpY2UgdHJpZXMgdG8gcGxhY2UgdGFza3NcbiAgICBzZXJ2aWNlLm5vZGUuYWRkRGVwZW5kZW5jeShhdXRvU2NhbGluZ0dyb3VwKTtcblxuICAgIC8vIFRhcmdldCBncm91cCBmb3IgZ1JQQyAoVENQKVxuICAgIC8vIE1vZGVsIGxvYWRpbmcgdGFrZXMgMi01IG1pbnV0ZXMsIHNvIHdlIG5lZWQgZ2VuZXJvdXMgaGVhbHRoIGNoZWNrIHNldHRpbmdzXG4gICAgY29uc3QgdGFyZ2V0R3JvdXAgPSBuZXcgZWxidjIuTmV0d29ya1RhcmdldEdyb3VwKHRoaXMsIGAke2lkUHJlZml4fVRhcmdldEdyb3VwYCwge1xuICAgICAgdnBjLFxuICAgICAgcG9ydDogNTAwNTEsXG4gICAgICBwcm90b2NvbDogZWxidjIuUHJvdG9jb2wuVENQLFxuICAgICAgdGFyZ2V0czogW3NlcnZpY2UubG9hZEJhbGFuY2VyVGFyZ2V0KHtcbiAgICAgICAgY29udGFpbmVyTmFtZTogJ3BhcmFrZWV0JyxcbiAgICAgICAgY29udGFpbmVyUG9ydDogNTAwNTEsXG4gICAgICB9KV0sXG4gICAgICBoZWFsdGhDaGVjazoge1xuICAgICAgICBwcm90b2NvbDogZWxidjIuUHJvdG9jb2wuVENQLFxuICAgICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgICBoZWFsdGh5VGhyZXNob2xkQ291bnQ6IDIsXG4gICAgICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiAxMCwgIC8vIEFsbG93IH41IG1pbiBmb3IgbW9kZWwgbG9hZGluZyAoMTAgKiAzMHMpXG4gICAgICB9LFxuICAgICAgZGVyZWdpc3RyYXRpb25EZWxheTogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgIH0pO1xuXG4gICAgLy8gTkxCIGxpc3RlbmVyIGZvciBnUlBDXG4gICAgbmxiLmFkZExpc3RlbmVyKGAke2lkUHJlZml4fUdycGNMaXN0ZW5lcmAsIHtcbiAgICAgIHBvcnQ6IDUwMDUxLFxuICAgICAgcHJvdG9jb2w6IGVsYnYyLlByb3RvY29sLlRDUCxcbiAgICAgIGRlZmF1bHRUYXJnZXRHcm91cHM6IFt0YXJnZXRHcm91cF0sXG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBubGIsIHNlcnZpY2UgfTtcbiAgfVxufVxuIl19