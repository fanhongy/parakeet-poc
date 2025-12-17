#!/bin/bash
# Build Lambda layer for gRPC dependencies
# Run this before cdk deploy

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LAYER_DIR="$PROJECT_DIR/lambda-layer"
VENV_DIR="$PROJECT_DIR/.venv"

echo "Building Lambda layer for gRPC..."

# Ensure venv exists and has grpcio-tools
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

# Use venv pip and python
VENV_PIP="$VENV_DIR/bin/pip"
VENV_PYTHON="$VENV_DIR/bin/python"

# Install grpcio-tools in venv if not present
"$VENV_PIP" install -q grpcio-tools

# Clean previous build
rm -rf "$LAYER_DIR/python"
mkdir -p "$LAYER_DIR/python"

# Install dependencies for Lambda (Amazon Linux 2)
"$VENV_PIP" install \
    --platform manylinux2014_x86_64 \
    --target "$LAYER_DIR/python" \
    --implementation cp \
    --python-version 3.12 \
    --only-binary=:all: \
    -r "$LAYER_DIR/requirements.txt"

# Generate protobuf files for Lambda
echo "Generating protobuf files..."
"$VENV_PYTHON" -m grpc_tools.protoc \
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
