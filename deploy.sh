#!/bin/bash
# One-command deployment script for Parakeet ASR
# Usage: ./deploy.sh [image-tag]
# Example: ./deploy.sh
#          ./deploy.sh v1.0.0

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="$SCRIPT_DIR/parakeet-poc"

cd "$CDK_DIR"

echo "============================================"
echo "  Parakeet ASR Deployment"
echo "============================================"
echo ""

# Run bootstrap to ensure prerequisites are met
./scripts/bootstrap.sh

# Run full deployment, passing through any arguments
./scripts/deploy-all.sh "$@"
