#!/bin/bash
# Test concurrent transcription by uploading same file multiple times with different names
# Usage: ./scripts/test-concurrent.sh [count] [prefix]
# Example: ./scripts/test-concurrent.sh 5 input/          # 5 concurrent jobs, standard
#          ./scripts/test-concurrent.sh 10 input-nochunk/ # 10 concurrent jobs, no-chunk

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SAMPLE_FILE="$(dirname "$PROJECT_DIR")/sampleaudio/4m36s.wav"

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="parakeet-poc-${AWS_ACCOUNT}-${AWS_REGION}"
COUNT="${1:-5}"
PREFIX="${2:-input/}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "============================================"
echo "  Concurrent Transcription Test"
echo "============================================"
echo "Source file: $SAMPLE_FILE"
echo "Concurrent jobs: $COUNT"
echo "Bucket: s3://${BUCKET}"
echo "Prefix: ${PREFIX}"
echo "Test ID: ${TIMESTAMP}"
echo ""

# Verify source file exists
if [ ! -f "$SAMPLE_FILE" ]; then
    echo "ERROR: Sample file not found: $SAMPLE_FILE"
    exit 1
fi

FILE_SIZE=$(ls -lh "$SAMPLE_FILE" | awk '{print $5}')
echo "File size: $FILE_SIZE"
echo ""

# Clear previous output files for this test
echo ">>> Clearing previous test outputs..."
aws s3 rm "s3://${BUCKET}/output/" --recursive --exclude "*" --include "test-${TIMESTAMP}*" 2>/dev/null || true
echo ""

# Upload same file multiple times with different names (in parallel)
echo ">>> Uploading $COUNT copies in parallel..."
START_TIME=$(date +%s)

for i in $(seq 1 $COUNT); do
    DEST_NAME="test-${TIMESTAMP}-job${i}.wav"
    echo "  [$i/$COUNT] Uploading as: ${DEST_NAME}"
    aws s3 cp "$SAMPLE_FILE" "s3://${BUCKET}/${PREFIX}${DEST_NAME}" &
done

# Wait for all uploads to complete
wait
UPLOAD_TIME=$(($(date +%s) - START_TIME))
echo ""
echo "All $COUNT files uploaded in ${UPLOAD_TIME}s"
echo ""

# Monitor progress
echo ">>> Monitoring transcription progress..."
echo "    (Press Ctrl+C to stop monitoring, jobs will continue)"
echo ""

EXPECTED_OUTPUTS=$COUNT
TIMEOUT=600  # 10 minutes
ELAPSED=0
INTERVAL=10

while [ $ELAPSED -lt $TIMEOUT ]; do
    OUTPUT_COUNT=$(aws s3 ls "s3://${BUCKET}/output/" 2>/dev/null | grep "test-${TIMESTAMP}" | grep "_transcript.json" | wc -l | tr -d ' ')
    PROGRESS_BAR=$(printf '█%.0s' $(seq 1 $OUTPUT_COUNT))$(printf '░%.0s' $(seq 1 $((EXPECTED_OUTPUTS - OUTPUT_COUNT))))
    echo -ne "\r  [$(date +%H:%M:%S)] Progress: ${OUTPUT_COUNT}/${EXPECTED_OUTPUTS} ${PROGRESS_BAR}  "
    
    if [ "$OUTPUT_COUNT" -ge "$EXPECTED_OUTPUTS" ]; then
        echo ""
        echo ""
        echo "All transcriptions complete!"
        break
    fi
    
    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))
done

TOTAL_TIME=$(($(date +%s) - START_TIME))
echo ""

# Download and analyze results
echo ">>> Downloading results..."
RESULTS_DIR="/tmp/parakeet-concurrent-${TIMESTAMP}"
mkdir -p "$RESULTS_DIR"
aws s3 sync "s3://${BUCKET}/output/" "$RESULTS_DIR/" --exclude "*" --include "test-${TIMESTAMP}*_transcript.json"

echo ""
echo "============================================"
echo "  Results Summary"
echo "============================================"
echo ""

# Calculate statistics
TOTAL_AUDIO=0
TOTAL_TRANSCRIBE=0
TOTAL_PROCESSING=0
MIN_TRANSCRIBE=999999
MAX_TRANSCRIBE=0

printf "%-25s %10s %12s %12s %10s\n" "Job" "Audio(s)" "Transcribe" "Total" "GPU Peak"
printf "%-25s %10s %12s %12s %10s\n" "---" "--------" "----------" "-----" "--------"

for f in "$RESULTS_DIR"/test-${TIMESTAMP}*_transcript.json; do
    if [ -f "$f" ]; then
        filename=$(basename "$f" | sed 's/_transcript.json//')
        duration=$(jq -r '.audio_duration_seconds' "$f")
        transcribe_time=$(jq -r '.timing.transcription_seconds' "$f")
        total_time=$(jq -r '.timing.total_seconds' "$f")
        gpu_peak=$(jq -r '.memory.gpu_peak_gb // "N/A"' "$f")
        
        printf "%-25s %10.1f %12.1fs %12.1fs %10sGB\n" "$filename" "$duration" "$transcribe_time" "$total_time" "$gpu_peak"
        
        TOTAL_AUDIO=$(echo "$TOTAL_AUDIO + $duration" | bc)
        TOTAL_TRANSCRIBE=$(echo "$TOTAL_TRANSCRIBE + $transcribe_time" | bc)
        TOTAL_PROCESSING=$(echo "$TOTAL_PROCESSING + $total_time" | bc)
        
        if (( $(echo "$transcribe_time < $MIN_TRANSCRIBE" | bc -l) )); then
            MIN_TRANSCRIBE=$transcribe_time
        fi
        if (( $(echo "$transcribe_time > $MAX_TRANSCRIBE" | bc -l) )); then
            MAX_TRANSCRIBE=$transcribe_time
        fi
    fi
done

AVG_TRANSCRIBE=$(echo "scale=1; $TOTAL_TRANSCRIBE / $COUNT" | bc)

echo ""
echo "============================================"
echo "  Statistics"
echo "============================================"
echo "Concurrent jobs:      $COUNT"
echo "Total audio:          ${TOTAL_AUDIO}s ($(echo "scale=1; $TOTAL_AUDIO / 60" | bc)min)"
echo "Wall clock time:      ${TOTAL_TIME}s"
echo "Transcribe time:"
echo "  - Min:              ${MIN_TRANSCRIBE}s"
echo "  - Max:              ${MAX_TRANSCRIBE}s"
echo "  - Avg:              ${AVG_TRANSCRIBE}s"
echo "Throughput:           $(echo "scale=1; $TOTAL_AUDIO / $TOTAL_TIME" | bc)x realtime"
echo ""

# Cleanup option
echo "To clean up test files:"
echo "  aws s3 rm s3://${BUCKET}/${PREFIX} --recursive --exclude '*' --include 'test-${TIMESTAMP}*'"
echo "  aws s3 rm s3://${BUCKET}/output/ --recursive --exclude '*' --include 'test-${TIMESTAMP}*'"
echo ""
