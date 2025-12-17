#!/bin/bash
# Test parallel Lambda invocations
# Usage: ./scripts/test-parallel.sh [count] [s3-key]
# Example: ./scripts/test-parallel.sh 5 input/4m36s.wav
#          ./scripts/test-parallel.sh 3 input-nochunk/40m22s.wav

set -e

LAMBDA_FUNCTION="ParakeetPocStack-TriggerLambda2FDB819B-abqQxFL5qLxD"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="parakeet-poc-${ACCOUNT_ID}-us-east-1"
COUNT="${1:-3}"
S3_KEY="${2:-input/4m36s.wav}"

echo "============================================"
echo "  Parallel Lambda Test"
echo "============================================"
echo "Function:    ${LAMBDA_FUNCTION}"
echo "Bucket:      ${BUCKET}"
echo "Key:         ${S3_KEY}"
echo "Parallel:    ${COUNT} invocations"
echo "============================================"
echo ""

# Check if file exists
if ! aws s3 ls "s3://${BUCKET}/${S3_KEY}" > /dev/null 2>&1; then
    echo "ERROR: File not found: s3://${BUCKET}/${S3_KEY}"
    exit 1
fi

# Create payload
PAYLOAD=$(cat <<EOF
{"Records":[{"s3":{"bucket":{"name":"${BUCKET}"},"object":{"key":"${S3_KEY}"}}}]}
EOF
)

echo "Launching ${COUNT} parallel invocations..."
START_TIME=$(date +%s)

# Launch all invocations in background
PIDS=()
for i in $(seq 1 $COUNT); do
    (
        RESULT=$(aws lambda invoke \
            --function-name "${LAMBDA_FUNCTION}" \
            --cli-binary-format raw-in-base64-out \
            --payload "${PAYLOAD}" \
            --output text \
            --query 'StatusCode' \
            /tmp/lambda_response_${i}.json 2>&1)
        echo "  [${i}] Status: ${RESULT}"
    ) &
    PIDS+=($!)
done

echo "Waiting for all invocations to complete..."
echo ""

# Wait for all background jobs
for pid in "${PIDS[@]}"; do
    wait $pid
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "============================================"
echo "  Results"
echo "============================================"
echo "Total time: ${DURATION}s for ${COUNT} parallel requests"
echo ""

# Show individual results
for i in $(seq 1 $COUNT); do
    if [ -f /tmp/lambda_response_${i}.json ]; then
        STATUS=$(jq -r '.statusCode // "error"' /tmp/lambda_response_${i}.json 2>/dev/null || echo "parse_error")
        TOTAL_TIME=$(jq -r '.body | fromjson | .timing.total_seconds // "N/A"' /tmp/lambda_response_${i}.json 2>/dev/null || echo "N/A")
        echo "  [${i}] HTTP ${STATUS}, Processing: ${TOTAL_TIME}s"
        rm -f /tmp/lambda_response_${i}.json
    fi
done

echo ""
echo "Monitor ECS logs:"
echo "  aws logs tail /ecs/parakeet-poc --follow"
