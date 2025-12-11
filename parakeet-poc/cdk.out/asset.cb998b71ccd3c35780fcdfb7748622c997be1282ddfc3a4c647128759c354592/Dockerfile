# NVIDIA NeMo container with Parakeet support
FROM nvcr.io/nvidia/nemo:24.05

WORKDIR /app

# Install additional dependencies
RUN pip install --no-cache-dir boto3

# Copy transcription script
COPY transcribe.py /app/transcribe.py

# Entry point
ENTRYPOINT ["python", "/app/transcribe.py"]
