#!/bin/bash
# Bootstrap script for Parakeet ASR deployment
# Ensures all prerequisites are installed and configured
# This script is idempotent - safe to run multiple times

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "============================================"
echo "  Parakeet ASR Bootstrap"
echo "============================================"
echo ""

# Step 1: Check required tools
echo ">>> Checking required tools..."

check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo "ERROR: $1 is not installed."
        echo "       $2"
        exit 1
    fi
    echo "  ✓ $1 found"
}

check_command "node" "Install Node.js: https://nodejs.org/"
check_command "npm" "Install npm: https://nodejs.org/"
check_command "python3" "Install Python 3: https://www.python.org/"
check_command "aws" "Install AWS CLI: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"

echo ""

# Step 2: Install Node dependencies
echo ">>> Checking Node dependencies..."
if [ ! -d "node_modules" ]; then
    echo "  Installing npm dependencies..."
    npm install
else
    echo "  ✓ node_modules already exists"
fi
echo ""

# Step 3: Set up Python virtual environment
echo ">>> Checking Python virtual environment..."
if [ ! -d ".venv" ]; then
    echo "  Creating Python virtual environment..."
    python3 -m venv .venv
else
    echo "  ✓ .venv already exists"
fi

# Install grpcio-tools in venv (idempotent)
echo "  Installing grpcio-tools..."
.venv/bin/pip install -q grpcio-tools
echo "  ✓ grpcio-tools installed"
echo ""

# Step 4: Check CDK bootstrap status
echo ">>> Checking CDK bootstrap status..."
AWS_REGION="${AWS_REGION:-us-east-1}"

# Check if CDKToolkit stack exists
if aws cloudformation describe-stacks --stack-name CDKToolkit --region "$AWS_REGION" &> /dev/null; then
    echo "  ✓ CDK already bootstrapped in $AWS_REGION"
else
    echo "  CDK not bootstrapped. Running cdk bootstrap..."
    npx cdk bootstrap "aws://$(aws sts get-caller-identity --query Account --output text)/$AWS_REGION"
    echo "  ✓ CDK bootstrap complete"
fi
echo ""

echo "============================================"
echo "  Bootstrap Complete!"
echo "============================================"
echo ""
echo "You can now run: ./scripts/deploy-all.sh"
echo ""
