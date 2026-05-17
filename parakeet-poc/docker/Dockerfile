# Parakeet ASR gRPC Server
# Based on NVIDIA NeMo with pre-installed dependencies

FROM nvcr.io/nvidia/nemo:24.09

# Build argument: set to "true" to compile TensorRT engine during build
# NOTE: Requires --gpus all during docker build (nvidia-docker)
# The engine is GPU-architecture-specific (e.g., compiled on A10G only works on A10G)
ARG BUILD_TENSORRT=false

# Install gRPC dependencies
RUN pip install --no-cache-dir \
    boto3 \
    grpcio \
    grpcio-tools \
    psutil

# Create non-root user for security
RUN useradd -m -u 1000 appuser

# Create app directory
WORKDIR /app

# Copy proto and generate Python files
COPY proto/transcribe.proto /app/
RUN python -m grpc_tools.protoc -I/app --python_out=/app --grpc_python_out=/app /app/transcribe.proto

# Copy transcription server and TensorRT export script
COPY scripts/transcribe_grpc.py /app/
COPY scripts/export_tensorrt.py /app/

# TensorRT engine compilation (requires --gpus all during build)
# NOTE: This requires building on a machine with the target GPU architecture
ARG PARAKEET_MODEL=nvidia/parakeet-ctc-0.6b
RUN if [ "$BUILD_TENSORRT" = "true" ]; then \
    echo "Building TensorRT engine..." && \
    python /app/export_tensorrt.py --model ${PARAKEET_MODEL} --output-dir /app/trt_model --fp16; \
fi

# Set ownership and switch to non-root user
RUN chown -R appuser:appuser /app
USER appuser

# Default environment variables (can be overridden at runtime)
ENV GRPC_PORT=50051
ENV CHUNK_DURATION=30
ENV MAX_AUDIO_DURATION_MINUTES=60
ENV USE_TENSORRT=false
ENV TENSORRT_ENGINE_PATH=/app/trt_model/model.engine
ENV TENSORRT_METADATA_PATH=/app/trt_model/metadata.json

EXPOSE 50051

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD python -c "import grpc; ch=grpc.insecure_channel('localhost:50051'); grpc.channel_ready_future(ch).result(timeout=3)" || exit 1

# Run gRPC server
CMD ["python", "/app/transcribe_grpc.py"]
