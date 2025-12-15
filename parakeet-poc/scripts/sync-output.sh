#!/bin/bash
# Sync S3 output folder to local sample-transcription directory

BUCKET="parakeet-poc-234937851863-us-east-1"
LOCAL_DIR="../sample-transcription"

echo "Syncing s3://${BUCKET}/output/ to ${LOCAL_DIR}/"
aws s3 sync "s3://${BUCKET}/output/" "${LOCAL_DIR}/" --exclude "*" --include "*.json"

echo "Done. Files:"
ls -la "${LOCAL_DIR}"/*.json 2>/dev/null || echo "No JSON files found"
