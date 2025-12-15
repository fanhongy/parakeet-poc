#!/bin/bash
# Build and push Parakeet ASR Docker image to ECR
#
# Usage: ./build-and-push.sh [tag]
# Example: ./build-and-push.sh latest
#          ./build-and-push.sh v1.0.0

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Configuration
AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="parakeet-asr"
IMAGE_TAG="${1:-latest}"

ECR_URI="${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}"

echo "=== Parakeet ASR Docker Build ==="
echo "AWS Account: ${AWS_ACCOUNT}"
echo "Region: ${AWS_REGION}"
echo "ECR Repo: ${ECR_REPO}"
echo "Image Tag: ${IMAGE_TAG}"
echo ""

# Create ECR repository if it doesn't exist
echo "Creating ECR repository (if needed)..."
aws ecr describe-repositories --repository-names ${ECR_REPO} --region ${AWS_REGION} 2>/dev/null || \
    aws ecr create-repository --repository-name ${ECR_REPO} --region ${AWS_REGION}

# Login to ECR
echo "Logging into ECR..."
aws ecr get-login-password --region ${AWS_REGION} | \
    docker login --username AWS --password-stdin ${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com

# Login to NVIDIA NGC (for base image)
echo "Logging into NVIDIA NGC..."
echo "Note: If this fails, you may need to set NGC_API_KEY environment variable"
if [ -n "$NGC_API_KEY" ]; then
    echo "$NGC_API_KEY" | docker login nvcr.io --username '$oauthtoken' --password-stdin
else
    echo "NGC_API_KEY not set - assuming already logged in or public access"
fi

# Build image for AMD64 (NeMo only has AMD64 images)
echo "Building Docker image for linux/amd64..."
cd "$PROJECT_DIR"
docker build \
    --platform linux/amd64 \
    -f docker/Dockerfile \
    -t ${ECR_REPO}:${IMAGE_TAG} \
    .

# Tag for ECR
docker tag ${ECR_REPO}:${IMAGE_TAG} ${ECR_URI}:${IMAGE_TAG}

# Push to ECR
echo "Pushing to ECR..."
docker push ${ECR_URI}:${IMAGE_TAG}

echo ""
echo "=== Build Complete ==="
echo "Image URI: ${ECR_URI}:${IMAGE_TAG}"
echo ""
echo "To use in CDK, update lib/parakeet-poc-stack.ts:"
echo "  image: ecs.ContainerImage.fromEcrRepository("
echo "    ecr.Repository.fromRepositoryName(this, 'ParakeetRepo', '${ECR_REPO}'),"
echo "    '${IMAGE_TAG}'"
echo "  )"
