import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

interface ParakeetPocStackProps extends cdk.StackProps {
  vpcId: string;
  parakeetModel: string;
}

export class ParakeetPocStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ParakeetPocStackProps) {
    super(scope, id, props);

    // Import existing VPC
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId });

    // S3 bucket for audio input, transcript output, and scripts
    const bucket = new s3.Bucket(this, 'AudioBucket', {
      bucketName: `parakeet-poc-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Upload transcribe script to S3 (deployed via CDK)
    new s3deploy.BucketDeployment(this, 'DeployScript', {
      sources: [s3deploy.Source.asset('./scripts')],
      destinationBucket: bucket,
      destinationKeyPrefix: 'scripts',
    });

    // ECS Cluster with GPU capacity
    const cluster = new ecs.Cluster(this, 'ParakeetCluster', {
      vpc,
      clusterName: 'parakeet-poc-cluster',
    });

    // Add GPU EC2 capacity (g4dn.2xlarge with 1x T4 GPU - 16GB VRAM, more CPU/RAM)
    // NeMo image is ~50GB, need larger root volume
    const autoScalingGroup = cluster.addCapacity('GpuCapacity', {
      instanceType: new ec2.InstanceType('g4dn.2xlarge'),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(ecs.AmiHardwareType.GPU),
      minCapacity: 1,
      maxCapacity: 1,
      desiredCapacity: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: autoscaling.BlockDeviceVolume.ebs(100, {
            volumeType: autoscaling.EbsDeviceVolumeType.GP3,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    // CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, 'ParakeetLogs', {
      logGroupName: '/ecs/parakeet-poc',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Task execution role
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Task role (for S3 access)
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    bucket.grantReadWrite(taskRole);

    // ECS Task Definition for GPU (g4dn.xlarge)
    const taskDefinition = new ecs.Ec2TaskDefinition(this, 'ParakeetTask', {
      executionRole,
      taskRole,
      family: 'parakeet-transcription',
      networkMode: ecs.NetworkMode.AWS_VPC,
    });

    // Container with HTTP server (model stays loaded)
    const container = taskDefinition.addContainer('parakeet', {
      image: ecs.ContainerImage.fromRegistry('nvcr.io/nvidia/nemo:24.05'),
      memoryLimitMiB: 15360,
      cpu: 4096,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'parakeet',
        logGroup,
      }),
      environment: {
        PARAKEET_MODEL: props.parakeetModel,
        S3_BUCKET: bucket.bucketName,
        AWS_DEFAULT_REGION: this.region!,
        PORT: '8080',
        PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True',
      },
      gpuCount: 1,
      command: [
        'bash', '-c',
        'pip install boto3 && aws s3 cp s3://${S3_BUCKET}/scripts/transcribe.py /tmp/transcribe.py && python /tmp/transcribe.py',
      ],
      portMappings: [{ containerPort: 8080 }],
    });

    // Security group for ECS service
    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc,
      description: 'Security group for Parakeet ECS service',
      allowAllOutbound: true,
    });

    // ALB Security group (only Lambda can access)
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'Security group for ALB',
      allowAllOutbound: true,
    });
    // Lambda SG will be added below after Lambda is created
    serviceSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(8080), 'Allow from ALB');

    // Internal ALB (Lambda in VPC will call this)
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ParakeetAlb', {
      vpc,
      internetFacing: false,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      idleTimeout: cdk.Duration.seconds(900), // 15 min to match Lambda timeout
    });

    // ECS Service (always running)
    const service = new ecs.Ec2Service(this, 'ParakeetService', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // Target group with long timeout for transcription
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ALB listener
    alb.addListener('HttpListener', {
      port: 80,
      defaultTargetGroups: [targetGroup],
    });

    // Lambda security group
    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
      description: 'Security group for Lambda',
      allowAllOutbound: true,
    });
    // Only Lambda can access the ALB
    albSecurityGroup.addIngressRule(lambdaSecurityGroup, ec2.Port.tcp(80), 'Allow from Lambda');

    // Lambda to trigger transcription via ALB
    const triggerLambda = new lambda.Function(this, 'TriggerLambda', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('./lambda'),
      timeout: cdk.Duration.minutes(15),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        SERVICE_URL: `http://${alb.loadBalancerDnsName}`,
        S3_BUCKET: bucket.bucketName,
      },
    });

    // S3 trigger for audio uploads
    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(triggerLambda),
      { prefix: 'input/', suffix: '.wav' },
    );
    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(triggerLambda),
      { prefix: 'input/', suffix: '.mp3' },
    );

    // Outputs
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'ServiceUrl', { value: `http://${alb.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'UploadCommand', {
      value: `aws s3 cp your-audio.wav s3://${bucket.bucketName}/input/`,
    });
  }
}
