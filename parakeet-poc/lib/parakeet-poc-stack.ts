import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

interface ParakeetServiceConfig {
  instanceType: string;
  chunkDurationSeconds: number;
  maxAudioDurationMinutes: number;
  inputPrefix: string;
  serviceName: string;
  numWorkers: number;  // Number of parallel worker processes (each loads model copy)
}

interface ParakeetPocStackProps extends cdk.StackProps {
  vpcId: string;
  parakeetModel: string;
  // Optional: use custom ECR image instead of pulling from NVIDIA NGC
  ecrRepoName?: string;
  ecrImageTag?: string;
  // Optional: image digest to force ECS task update when image changes
  // Pass the digest from ECR (e.g., sha256:abc123...) to trigger rolling update
  ecrImageDigest?: string;
}

export class ParakeetPocStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ParakeetPocStackProps) {
    super(scope, id, props);

    // Service configurations for dual-path architecture
    const standardConfig: ParakeetServiceConfig = {
      instanceType: 'g5.2xlarge',
      chunkDurationSeconds: 30,
      maxAudioDurationMinutes: 60,
      inputPrefix: 'input/',
      serviceName: 'standard',
      numWorkers: 5,  // 2 workers × ~1.3GB = ~2.6GB GPU (A10G has 24GB)
    };

    // Long audio service with larger GPU for bigger chunks
    // g5.2xlarge has A10G (24GB VRAM) - can handle 60s chunks safely
    // T4 (16GB) can only handle 30s chunks due to model size (~13GB)
    const noChunkConfig: ParakeetServiceConfig = {
      // instanceType: 'p4de.24xlarge',  // A100 80GB
      // instanceType: 'g4dn.2xlarge',  // T4 16GB - use 30s chunks max
      instanceType: 'g5.2xlarge',       // A10G 24GB - can handle 60s chunks
      chunkDurationSeconds: 60*10,         // 600s chunks (safe for A10G 24GB)
      maxAudioDurationMinutes: 60,
      inputPrefix: 'input-nochunk/',
      serviceName: 'no-chunk',
      numWorkers: 2,  // 2 workers for parallel processing
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
    const standardService = this.createParakeetService(
      standardConfig, vpc, cluster, bucket, logGroup, executionRole, taskRole, 
      lambdaSecurityGroup, props.parakeetModel, 'Standard',
      props.ecrRepoName, props.ecrImageTag, props.ecrImageDigest
    );

    const noChunkService = this.createParakeetService(
      noChunkConfig, vpc, cluster, bucket, logGroup, executionRole, taskRole,
      lambdaSecurityGroup, props.parakeetModel, 'NoChunk',
      props.ecrRepoName, props.ecrImageTag, props.ecrImageDigest
    );

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
    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(triggerLambda),
      { prefix: standardConfig.inputPrefix, suffix: '.wav' },
    );
    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(triggerLambda),
      { prefix: standardConfig.inputPrefix, suffix: '.mp3' },
    );

    // S3 triggers for no-chunk audio (input-nochunk/)
    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(triggerLambda),
      { prefix: noChunkConfig.inputPrefix, suffix: '.wav' },
    );
    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(triggerLambda),
      { prefix: noChunkConfig.inputPrefix, suffix: '.mp3' },
    );

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


  private createParakeetService(
    config: ParakeetServiceConfig,
    vpc: ec2.IVpc,
    cluster: ecs.Cluster,
    bucket: s3.Bucket,
    logGroup: logs.LogGroup,
    executionRole: iam.Role,
    taskRole: iam.Role,
    _lambdaSecurityGroup: ec2.SecurityGroup,
    parakeetModel: string,
    idPrefix: string,
    ecrRepoName?: string,
    ecrImageTag?: string,
    ecrImageDigest?: string,
  ): { nlb: elbv2.NetworkLoadBalancer; service: ecs.Ec2Service } {
    
    // Determine memory/CPU based on instance type
    // Sized to allow 2 tasks per instance for rolling deployments
    const isP4d = config.instanceType.startsWith('p4d');
    const isG5 = config.instanceType.startsWith('g5');
    const isG4dn = config.instanceType.startsWith('g4dn');
    
    let memoryMiB = 15360;  // default
    let cpu = 4096;
    
    if (isP4d) {
      // p4de.24xlarge: 1152GB RAM, 96 vCPU, 8x A100 GPUs
      // Use ~40% to allow 2 tasks
      memoryMiB = 450 * 1024;  // 450GB (of 1152GB)
      cpu = 40 * 1024;         // 40 vCPU (of 96)
    } else if (isG5) {
      // g5.4xlarge: 64GB RAM, 16 vCPU, 1x A10G GPU
      memoryMiB = 28 * 1024;   // 28GB (of 64GB)
      cpu = 7 * 1024;          // 7 vCPU (of 16)
    } else if (isG4dn) {
      // g4dn.2xlarge: 32GB RAM, 8 vCPU, 1x T4 GPU
      memoryMiB = 14 * 1024;   // 14GB (of 32GB)
      cpu = 3 * 1024;          // 3 vCPU (of 8)
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
    userData.addCommands(
      '#!/bin/bash',
      'set -e',
      '',
      '# Configure ECS agent',
      `echo ECS_CLUSTER=${cluster.clusterName} >> /etc/ecs/ecs.config`,
      'echo ECS_ENABLE_GPU_SUPPORT=true >> /etc/ecs/ecs.config',
    );

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
    let containerImage: ecs.ContainerImage;
    let containerCommand: string[] | undefined;
    
    if (ecrRepoName) {
      // Use pre-built ECR image (faster startup, no runtime pip install)
      const ecrRepo = ecr.Repository.fromRepositoryName(this, `${idPrefix}EcrRepo`, ecrRepoName);
      // Use digest if provided (triggers ECS update when image changes), otherwise use tag
      containerImage = ecrImageDigest
        ? ecs.ContainerImage.fromRegistry(`${ecrRepo.repositoryUri}@${ecrImageDigest}`)
        : ecs.ContainerImage.fromEcrRepository(ecrRepo, ecrImageTag || 'latest');
      containerCommand = undefined;  // Dockerfile has CMD
    } else {
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
        AWS_DEFAULT_REGION: this.region!,
        GRPC_PORT: '50051',
        PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True',
        USE_FP16: 'true',  // Use half-precision to reduce GPU memory (~50% reduction)
        CHUNK_DURATION: config.chunkDurationSeconds.toString(),
        MAX_AUDIO_DURATION_MINUTES: config.maxAudioDurationMinutes.toString(),
        NUM_WORKERS: config.numWorkers.toString(),  // Parallel worker processes
      },
      gpuCount: 1,
      ...(containerCommand && { command: containerCommand }),
      portMappings: [{ containerPort: 50051 }],
      // NeMo recommended settings for better GPU memory handling
      linuxParameters: new ecs.LinuxParameters(this, `${idPrefix}LinuxParams`, {
        sharedMemorySize: 2048,  // 2GB shared memory (vs default 64MB)
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
    serviceSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(50051), 
      'Allow gRPC from VPC (NLB + Lambda)'
    );

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
        unhealthyThresholdCount: 10,  // Allow ~5 min for model loading (10 * 30s)
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
