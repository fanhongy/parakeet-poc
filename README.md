# NVIDIA Parakeet ASR on AWS ECS

A proof-of-concept for running NVIDIA Parakeet automatic speech recognition (ASR) models on AWS ECS with GPU acceleration. Features an event-driven architecture using gRPC for high-performance audio transcription.

## Overview

This project demonstrates how to deploy NVIDIA's Parakeet speech-to-text models on AWS infrastructure with:

- **GPU-accelerated inference** using NVIDIA T4 and A10G GPUs
- **Event-driven processing** triggered by S3 uploads
- **gRPC communication** for efficient binary serialization and low latency
- **Dual-path routing** for optimized processing of different audio lengths
- **Configurable chunking** to manage GPU memory efficiently

## Architecture

```
┌─────────────┐     ┌─────────┐     ┌─────────────┐     ┌─────────────────────┐     ┌─────────────┐
│  S3 Bucket  │────▶│ Lambda  │────▶│ NLB (gRPC)  │────▶│ ECS Task (GPU)      │────▶│  S3 Output  │
│  (input/)   │     │ Trigger │     │ Port 50051  │     │ NeMo + Parakeet     │     │  (output/)  │
└─────────────┘     └─────────┘     └─────────────┘     └─────────────────────┘     └─────────────┘
```

### Service Configurations

| S3 Prefix | Instance | GPU | VRAM | Chunk Size | Max Audio |
|-----------|----------|-----|------|------------|-----------|
| `input/` | g4dn.2xlarge | T4 | 16GB | 30s | 60 min |
| `input-nochunk/` | g5.2xlarge | A10G | 24GB | 60s | 60 min |

## Tech Stack

| Component | Technology |
|-----------|------------|
| Infrastructure | AWS CDK (TypeScript) |
| Compute | ECS on EC2 with GPU instances |
| Container | NVIDIA NeMo 24.09 |
| ASR Model | NVIDIA Parakeet (ctc/rnnt/tdt variants) |
| Protocol | gRPC with Protocol Buffers |
| Trigger | Lambda (Python 3.12) |

## Quick Start

```bash
cd parakeet-poc
npm install

# Build Lambda layer for gRPC
python3 -m venv .venv
.venv/bin/pip install grpcio-tools
./scripts/build-lambda-layer.sh

# Deploy
cdk bootstrap  # first time only
cdk deploy
```

## Using Pre-built ECR Images (Recommended)

By default, the stack pulls the NeMo container from NVIDIA NGC and installs dependencies at runtime. For faster ECS task startup (~2-3 min vs ~5-10 min), you can pre-build and push a container to ECR.

### Option 1: Build via CodeBuild (Recommended)

Use CodeBuild to build and push the image - faster than local builds and doesn't require local Docker.

```bash
cd parakeet-poc

# Deploy the CodeBuild stack (first time only)
cdk deploy ParakeetCodeBuildStack

# Upload build assets and trigger build
./scripts/deploy-image.sh           # builds with tag 'latest'
./scripts/deploy-image.sh v1.0.0    # builds with custom tag
```

Monitor the build:
```bash
aws logs tail /codebuild/parakeet-asr --follow
```

### Option 2: Build Locally

```bash
cd parakeet-poc/docker

# Build and push (requires Docker with ~50GB free space)
# Use --platform linux/amd64 if building on ARM Mac
./build-and-push.sh
```

### Deploy with ECR Image

Edit `parakeet-poc/bin/parakeet-poc.ts` to specify the ECR repo:

```typescript
new ParakeetPocStack(app, 'ParakeetPocStack', {
  vpcId: 'vpc-xxxxxxxxx',
  parakeetModel: 'nvidia/parakeet-ctc-0.6b',
  ecrRepoName: 'parakeet-asr',      // Add this
  ecrImageTag: 'latest',            // Optional, defaults to 'latest'
});
```

Then redeploy:

```bash
cdk deploy ParakeetPocStack
```

### Benefits of ECR Images

| Approach | Task Startup | First Request |
|----------|--------------|---------------|
| NGC (default) | ~5-10 min | Includes pip install + S3 script download |
| ECR (pre-built) | ~2-3 min | Dependencies pre-installed |

## Usage

Upload audio to S3 to trigger transcription:

```bash
# Standard processing (30s chunks)
aws s3 cp audio.wav s3://parakeet-poc-<account>-us-east-1/input/

# Larger chunks (60s, requires more GPU memory)
aws s3 cp audio.wav s3://parakeet-poc-<account>-us-east-1/input-nochunk/

# Get results
aws s3 cp s3://parakeet-poc-<account>-us-east-1/output/audio_transcript.json .
```

## Supported Models

Configure in `parakeet-poc/bin/parakeet-poc.ts`:

| Model | Size | Notes |
|-------|------|-------|
| `nvidia/parakeet-ctc-0.6b` | 0.6B | Smaller, faster |
| `nvidia/parakeet-rnnt-1.1b` | 1.1B | Balanced |
| `nvidia/parakeet-tdt-1.1b` | 1.1B | Best accuracy |

## Supported Audio Formats

- `.wav`
- `.mp3`

## Project Structure

```
parakeet-poc/
├── bin/                    # CDK app entry point
├── lib/                    # CDK stack definitions
│   ├── parakeet-poc-stack.ts   # Main ECS infrastructure
│   └── codebuild-stack.ts      # CodeBuild for Docker builds
├── lambda/                 # Lambda gRPC client
├── scripts/                # Scripts
│   ├── transcribe_grpc.py      # gRPC transcription server
│   ├── deploy-image.sh         # Upload assets & trigger CodeBuild
│   └── build-lambda-layer.sh   # Build Lambda layer with gRPC
├── proto/                  # Protocol buffer definitions
├── lambda-layer/           # Lambda dependencies (gRPC, protobuf)
└── docker/                 # Container image definition
```

## Output Format

```json
{
  "input_file": "input/audio.wav",
  "model": "nvidia/parakeet-ctc-0.6b",
  "transcription": "full transcription text...",
  "segments": [
    {"index": 0, "start_time": 0, "end_time": 30, "text": "segment text..."}
  ],
  "audio_duration_seconds": 180.5,
  "timing": {
    "download_seconds": 1.2,
    "prep_seconds": 0.8,
    "transcription_seconds": 15.3,
    "total_seconds": 17.3
  },
  "memory": {
    "gpu_peak_gb": 15.96,
    "gpu_total_gb": 23.6
  }
}
```

## Performance

Benchmarks on g5.2xlarge (A10G 24GB) with `parakeet-ctc-0.6b`:

| Audio Length | Chunks | Transcription Time | Real-time Factor |
|--------------|--------|-------------------|------------------|
| 40 min | 5 x 600s | ~17s | ~140x |
| 50 min | 6 x 600s | ~22s | ~140x |

## License

This project is for demonstration purposes. NVIDIA NeMo and Parakeet models are subject to NVIDIA's licensing terms.
