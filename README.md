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
├── lib/                    # CDK stack definition
├── lambda/                 # Lambda gRPC client
├── scripts/                # gRPC transcription server
├── proto/                  # Protocol buffer definitions
├── lambda-layer/           # Lambda dependencies
└── docker/                 # Optional pre-built container
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
