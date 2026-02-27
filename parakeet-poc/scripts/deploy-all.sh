#!/bin/bash
# Full deployment script for Parakeet ASR
# Usage: ./scripts/deploy-all.sh [image-tag]
# Example: ./scripts/deploy-all.sh
#          ./scripts/deploy-all.sh v1.0.0

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
IMAGE_TAG="${1:-latest}"

cd "$PROJECT_DIR"

echo "============================================"
echo "  Parakeet ASR Full Deployment"
echo "============================================"
echo "Image Tag: ${IMAGE_TAG}"
echo ""

# Step 0: Bootstrap prerequisites (idempotent)
echo ">>> Step 0/4: Ensuring prerequisites..."
./scripts/bootstrap.sh
echo ""

# Step 1: Build Lambda Layer
echo ">>> Step 1/4: Building Lambda layer..."
if [ ! -d ".venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv .venv
fi
.venv/bin/pip install -q grpcio-tools
./scripts/build-lambda-layer.sh
echo "Lambda layer built."
echo ""

# Step 2: Deploy CodeBuild stack (if not already deployed)
echo ">>> Step 2/4: Deploying CodeBuild stack..."
npx cdk deploy ParakeetCodeBuildStack --require-approval never
echo "CodeBuild stack deployed."
echo ""

# Step 3: Build and push Docker image via CodeBuild
echo ">>> Step 3/4: Building Docker image via CodeBuild..."
./scripts/deploy-image.sh "$IMAGE_TAG"

# Wait for build to complete
AWS_REGION="${AWS_REGION:-us-east-1}"
CODEBUILD_PROJECT="parakeet-asr-build"

echo "Waiting for CodeBuild to complete..."
BUILD_ID=$(aws codebuild list-builds-for-project \
    --project-name ${CODEBUILD_PROJECT} \
    --sort-order DESCENDING \
    --query 'ids[0]' --output text)

while true; do
    STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" \
        --query 'builds[0].buildStatus' --output text)
    
    if [ "$STATUS" = "SUCCEEDED" ]; then
        echo "CodeBuild completed successfully!"
        break
    elif [ "$STATUS" = "FAILED" ] || [ "$STATUS" = "FAULT" ] || [ "$STATUS" = "STOPPED" ]; then
        echo "CodeBuild failed with status: $STATUS"
        echo "Check logs: aws logs tail /codebuild/parakeet-asr --follow"
        exit 1
    else
        echo "  Build status: $STATUS (waiting...)"
        sleep 30
    fi
done
echo ""

# Get the image digest from ECR
echo "Fetching image digest from ECR..."
ECR_REPO="parakeet-asr"
IMAGE_DIGEST=$(aws ecr describe-images \
    --repository-name ${ECR_REPO} \
    --image-ids imageTag=${IMAGE_TAG} \
    --query 'imageDetails[0].imageDigest' \
    --output text \
    --region ${AWS_REGION})

if [ -z "$IMAGE_DIGEST" ] || [ "$IMAGE_DIGEST" = "None" ]; then
    echo "ERROR: Failed to get image digest for ${ECR_REPO}:${IMAGE_TAG}"
    exit 1
fi
echo "Image digest: ${IMAGE_DIGEST}"
echo ""

# Step 4: Deploy main stack with image digest
echo ">>> Step 4/4: Deploying main Parakeet stack with image digest..."
npx cdk deploy ParakeetPocStack --require-approval never -c imageDigest=${IMAGE_DIGEST}
echo ""

echo "============================================"
echo "  Deployment Complete!"
echo "============================================"
echo ""
echo "Test with:"
echo "  aws s3 cp your-audio.wav s3://parakeet-poc-\$(aws sts get-caller-identity --query Account --output text)-us-east-1/input/"
echo ""
echo "Monitor:"
echo "  aws logs tail /ecs/parakeet-poc --follow"
echo ""
