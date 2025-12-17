#!/bin/bash
# Test Lambda function directly by invoking with a mock S3 event
# Usage: ./scripts/test-lambda.sh <s3-key>
# Example: ./scripts/test-lambda.sh input/4m36s.wav
#          ./scripts/test-lambda.sh input-nochunk/40m22s.wav

set -e

LAMBDA_FUNCTION="ParakeetPocStack-TriggerLambda2FDB819B-abqQxFL5qLxD"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="parakeet-poc-${ACCOUNT_ID}-us-east-1"
S3_KEY="${1:-input/4m36s.wav}"

echo "============================================"
echo "  Lambda Test Invocation"
echo "============================================"
echo "Function: ${LAMBDA_FUNCTION}"
echo "Bucket:   ${BUCKET}"
echo "Key:      ${S3_KEY}"
echo "============================================"
echo ""

# Check if file exists in S3
echo "Checking if file exists in S3..."
if ! aws s3 ls "s3://${BUCKET}/${S3_KEY}" > /dev/null 2>&1; then
    echo "ERROR: File not found: s3://${BUCKET}/${S3_KEY}"
    echo ""
    echo "Available files in input/:"
    aws s3 ls "s3://${BUCKET}/input/" 2>/dev/null || echo "  (none)"
    echo ""
    echo "Available files in input-nochunk/:"
    aws s3 ls "s3://${BUCKET}/input-nochunk/" 2>/dev/null || echo "  (none)"
    exit 1
fi
echo "File found!"
echo ""

# Create test event payload
PAYLOAD=$(cat <<EOF
{
  "Records": [{
    "s3": {
      "bucket": {"name": "${BUCKET}"},
      "object": {"key": "${S3_KEY}"}
    }
  }]
}
EOF
)

echo "Invoking Lambda..."
echo ""

# Invoke Lambda and capture response
RESPONSE=$(aws lambda invoke \
    --function-name "${LAMBDA_FUNCTION}" \
    --cli-binary-format raw-in-base64-out \
    --payload "${PAYLOAD}" \
    --log-type Tail \
    --query 'LogResult' \
    --output text \
    /dev/stdout 2>/dev/null)

echo ""
echo "============================================"
echo "  Response"
echo "============================================"
echo "${RESPONSE}" | head -1 | jq . 2>/dev/null || echo "${RESPONSE}" | head -1

echo ""
echo "Check ECS logs for EMF metrics:"
echo "  aws logs tail /ecs/parakeet-poc --follow"
