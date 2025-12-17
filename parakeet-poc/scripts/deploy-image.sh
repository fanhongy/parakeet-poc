#!/bin/bash
# Deploy Docker image via CodeBuild
# Usage: ./scripts/deploy-image.sh [tag]
# Example: ./scripts/deploy-image.sh latest
#          ./scripts/deploy-image.sh v1.0.0

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Configuration
AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ASSETS_BUCKET="parakeet-build-assets-${AWS_ACCOUNT}-${AWS_REGION}"
CODEBUILD_PROJECT="parakeet-asr-build"
IMAGE_TAG="${1:-latest}"

echo "=== Parakeet ASR Image Deploy ==="
echo "AWS Account: ${AWS_ACCOUNT}"
echo "Region: ${AWS_REGION}"
echo "Assets Bucket: ${ASSETS_BUCKET}"
echo "Image Tag: ${IMAGE_TAG}"
echo ""

# Upload build assets to S3
echo "Uploading build assets to S3..."
aws s3 cp "${PROJECT_DIR}/docker/Dockerfile" "s3://${ASSETS_BUCKET}/"
aws s3 cp "${PROJECT_DIR}/scripts/transcribe_grpc.py" "s3://${ASSETS_BUCKET}/"
aws s3 cp "${PROJECT_DIR}/proto/transcribe.proto" "s3://${ASSETS_BUCKET}/"
echo "Assets uploaded."
echo ""

# Start CodeBuild
echo "Starting CodeBuild..."
if [ "$IMAGE_TAG" = "latest" ]; then
    BUILD_ID=$(aws codebuild start-build \
        --project-name ${CODEBUILD_PROJECT} \
        --query 'build.id' --output text)
else
    BUILD_ID=$(aws codebuild start-build \
        --project-name ${CODEBUILD_PROJECT} \
        --environment-variables-override "name=IMAGE_TAG,value=${IMAGE_TAG},type=PLAINTEXT" \
        --query 'build.id' --output text)
fi

echo "Build started: ${BUILD_ID}"
echo ""
echo "Monitor build:"
echo "  aws codebuild batch-get-builds --ids ${BUILD_ID} --query 'builds[0].buildStatus'"
echo "  aws logs tail /codebuild/parakeet-asr --follow"
echo ""
echo "ECR image will be available at:"
echo "  ${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com/parakeet-asr:${IMAGE_TAG}"
