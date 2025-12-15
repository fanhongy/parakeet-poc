#!/bin/bash
# Build Lambda layer for gRPC dependencies
# Run this before cdk deploy

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LAYER_DIR="$PROJECT_DIR/lambda-layer"

echo "Building Lambda layer for gRPC..."

# Clean previous build
rm -rf "$LAYER_DIR/python"
mkdir -p "$LAYER_DIR/python"

# Install dependencies for Lambda (Amazon Linux 2)
pip install \
    --platform manylinux2014_x86_64 \
    --target "$LAYER_DIR/python" \
    --implementation cp \
    --python-version 3.12 \
    --only-binary=:all: \
    -r "$LAYER_DIR/requirements.txt"

# Generate protobuf files for Lambda
echo "Generating protobuf files..."
python -m grpc_tools.protoc \
    -I"$PROJECT_DIR/proto" \
    --python_out="$LAYER_DIR/python" \
    --grpc_python_out="$LAYER_DIR/python" \
    "$PROJECT_DIR/proto/transcribe.proto"

# Also copy to lambda directory for local testing
cp "$LAYER_DIR/python/transcribe_pb2.py" "$PROJECT_DIR/lambda/"
cp "$LAYER_DIR/python/transcribe_pb2_grpc.py" "$PROJECT_DIR/lambda/"

echo "Lambda layer built successfully at $LAYER_DIR"
echo "Generated files:"
ls -la "$LAYER_DIR/python/"
