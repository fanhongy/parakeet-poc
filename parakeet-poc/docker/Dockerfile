# Parakeet ASR gRPC Server
# Based on NVIDIA NeMo with pre-installed dependencies

FROM nvcr.io/nvidia/nemo:24.09

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

# Copy transcription server
COPY scripts/transcribe_grpc.py /app/

# Set ownership and switch to non-root user
RUN chown -R appuser:appuser /app
USER appuser

# Default environment variables (can be overridden at runtime)
ENV GRPC_PORT=50051
ENV CHUNK_DURATION=30
ENV MAX_AUDIO_DURATION_MINUTES=60

EXPOSE 50051

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD python -c "import grpc; ch=grpc.insecure_channel('localhost:50051'); grpc.channel_ready_future(ch).result(timeout=3)" || exit 1

# Run gRPC server
CMD ["python", "/app/transcribe_grpc.py"]
