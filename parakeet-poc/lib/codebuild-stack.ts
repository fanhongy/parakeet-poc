import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface ParakeetCodeBuildStackProps extends cdk.StackProps {
  /**
   * Optional: NGC API key for pulling NVIDIA base images
   * If not provided, assumes public access or pre-authenticated
   */
  ngcApiKeySecretArn?: string;
  /**
   * If true, import existing ECR repo instead of creating new one
   * Use this if 'parakeet-asr' repo already exists
   */
  useExistingEcrRepo?: boolean;
}

export class ParakeetCodeBuildStack extends cdk.Stack {
  public readonly ecrRepository: ecr.Repository;
  public readonly codeBuildProject: codebuild.Project;

  constructor(scope: Construct, id: string, props?: ParakeetCodeBuildStackProps) {
    super(scope, id, props);

    // ECR Repository for Parakeet ASR images
    const ecrRepoName = 'parakeet-asr';
    if (props?.useExistingEcrRepo) {
      // Import existing repo (use if repo was created manually or by build-and-push.sh)
      this.ecrRepository = ecr.Repository.fromRepositoryName(
        this, 'ParakeetEcrRepo', ecrRepoName
      ) as ecr.Repository;
    } else {
      // Create new repo
      this.ecrRepository = new ecr.Repository(this, 'ParakeetEcrRepo', {
        repositoryName: ecrRepoName,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        lifecycleRules: [
          {
            maxImageCount: 10,
            description: 'Keep only 10 most recent images',
          },
        ],
      });
    }

    // CloudWatch Log Group for build logs
    const logGroup = new logs.LogGroup(this, 'BuildLogs', {
      logGroupName: '/codebuild/parakeet-asr',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // S3 bucket for build assets (Dockerfile, scripts, proto)
    const assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      bucketName: `parakeet-build-assets-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // S3 bucket for Docker build cache
    const cacheBucket = new s3.Bucket(this, 'CacheBucket', {
      bucketName: `parakeet-build-cache-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(30), // Clean up old cache after 30 days
        },
      ],
    });



    // CodeBuild project - no source, downloads assets from S3
    this.codeBuildProject = new codebuild.Project(this, 'ParakeetBuildProject', {
      projectName: 'parakeet-asr-build',
      description: 'Build and push Parakeet ASR Docker image to ECR',
      buildSpec: this.createBuildSpec(assetsBucket.bucketName, cacheBucket.bucketName),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.LARGE,
        privileged: true, // Required for Docker builds
      },
      environmentVariables: {
        AWS_ACCOUNT_ID: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: this.account,
        },
        AWS_DEFAULT_REGION: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: this.region,
        },
        ECR_REPO_URI: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: this.ecrRepository.repositoryUri,
        },
        IMAGE_TAG: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: 'latest',
        },
      },

      logging: {
        cloudWatch: {
          logGroup,
          enabled: true,
        },
      },
      // Use S3 cache for Docker BuildKit cache - persists across builds
      cache: codebuild.Cache.bucket(cacheBucket, {
        prefix: 'docker-cache',
      }),
      timeout: cdk.Duration.hours(2), // NeMo base image is large (~15GB)
    });

    // Grant CodeBuild permission to push to ECR, read from assets bucket, and read/write cache bucket
    this.ecrRepository.grantPullPush(this.codeBuildProject);
    assetsBucket.grantRead(this.codeBuildProject);
    cacheBucket.grantReadWrite(this.codeBuildProject);

    // If NGC API key secret is provided, grant access and add env var
    if (props?.ngcApiKeySecretArn) {
      this.codeBuildProject.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [props.ngcApiKeySecretArn],
      }));
      
      // Add NGC_API_KEY environment variable from Secrets Manager
      const cfnProject = this.codeBuildProject.node.defaultChild as codebuild.CfnProject;
      cfnProject.addPropertyOverride('Environment.EnvironmentVariables.-1', {
        Name: 'NGC_API_KEY',
        Type: 'SECRETS_MANAGER',
        Value: props.ngcApiKeySecretArn,
      });
    }

    // Outputs
    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: this.ecrRepository.repositoryUri,
      description: 'ECR Repository URI for Parakeet ASR images',
    });

    new cdk.CfnOutput(this, 'CodeBuildProjectName', {
      value: this.codeBuildProject.projectName,
      description: 'CodeBuild project name',
    });

    new cdk.CfnOutput(this, 'AssetsBucketName', {
      value: assetsBucket.bucketName,
      description: 'S3 bucket for build assets',
    });

    new cdk.CfnOutput(this, 'UploadAssetsCommand', {
      value: `aws s3 cp parakeet-poc/docker/Dockerfile s3://${assetsBucket.bucketName}/ && aws s3 cp parakeet-poc/scripts/transcribe_grpc.py s3://${assetsBucket.bucketName}/ && aws s3 cp parakeet-poc/proto/transcribe.proto s3://${assetsBucket.bucketName}/`,
      description: 'Command to upload build assets',
    });

    new cdk.CfnOutput(this, 'StartBuildCommand', {
      value: `aws codebuild start-build --project-name ${this.codeBuildProject.projectName}`,
      description: 'Command to trigger a build',
    });

    new cdk.CfnOutput(this, 'StartBuildWithTagCommand', {
      value: `aws codebuild start-build --project-name ${this.codeBuildProject.projectName} --environment-variables-override name=IMAGE_TAG,value=v1.0.0,type=PLAINTEXT`,
      description: 'Command to trigger a build with custom tag',
    });
  }

  private createBuildSpec(assetsBucketName: string, _cacheBucketName: string): codebuild.BuildSpec {
    return codebuild.BuildSpec.fromObject({
      version: '0.2',
      env: {
        variables: {
          DOCKER_BUILDKIT: '1',
        },
      },
      phases: {
        pre_build: {
          commands: [
            'echo Logging in to Amazon ECR...',
            'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com',
            'echo Logging in to NVIDIA NGC...',
            'if [ -n "$NGC_API_KEY" ]; then echo "$NGC_API_KEY" | docker login nvcr.io --username \'$oauthtoken\' --password-stdin; else echo "NGC_API_KEY not set - using public access"; fi',
            'echo Downloading build assets from S3...',
            'mkdir -p docker proto scripts',
            `aws s3 cp s3://${assetsBucketName}/Dockerfile docker/`,
            `aws s3 cp s3://${assetsBucketName}/transcribe.proto proto/`,
            `aws s3 cp s3://${assetsBucketName}/transcribe_grpc.py scripts/`,
          ],
        },
        build: {
          commands: [
            'echo Build started on `date`',
            'echo Building Docker image...',
            // Simple docker build without cache-to (not supported by default driver)
            `docker build --platform linux/amd64 \\
              --build-arg BUILDKIT_INLINE_CACHE=1 \\
              -f docker/Dockerfile \\
              -t $ECR_REPO_URI:$IMAGE_TAG .`,
            'docker tag $ECR_REPO_URI:$IMAGE_TAG $ECR_REPO_URI:build-$CODEBUILD_BUILD_NUMBER',
          ],
        },
        post_build: {
          commands: [
            'echo Build completed on `date`',
            'echo Pushing Docker image to ECR...',
            'docker push $ECR_REPO_URI:$IMAGE_TAG',
            'docker push $ECR_REPO_URI:build-$CODEBUILD_BUILD_NUMBER',
            'echo Image pushed: $ECR_REPO_URI:$IMAGE_TAG',
          ],
        },
      },
    });
  }
}
