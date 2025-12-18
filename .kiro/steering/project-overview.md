<!---
  Project Overview - Always included in context
  inclusion: always
--->

# Parakeet ASR PoC

## Project Purpose

This is a proof-of-concept for running NVIDIA Parakeet speech-to-text models on AWS ECS with GPU acceleration. It demonstrates an event-driven architecture for audio transcription with dual-path processing for different audio lengths.

## Architecture

Dual-path architecture routes audio to appropriate services based on S3 prefix:

```
S3 (input/)      → Lambda → NLB (gRPC) → ECS Standard (g4dn.2xlarge)  → S3 (output/)
S3 (input-long/) → Lambda → NLB (gRPC) → ECS Long Audio (g5.4xlarge) → S3 (output/)
```

Uses gRPC over HTTP/2 for significantly better performance than REST/HTTP:
- Binary protocol with efficient protobuf serialization
- HTTP/2 multiplexing and streaming
- Lower latency and reduced overhead

### Service Configurations

| Prefix | Instance | GPU | Chunking | Max Audio |
|--------|----------|-----|----------|-----------|
| `input/` | g4dn.2xlarge | T4 (16GB) | 30s chunks | 30 min |
| `input-long/` | g5.4xlarge | A10G (24GB) | No chunking | 60 min |

## Tech Stack

- **Infrastructure**: AWS CDK (TypeScript)
- **Compute**: ECS on EC2 with GPU instances (g4dn.2xlarge / g5.4xlarge)
- **Container**: NVIDIA NeMo 24.09 (`nvcr.io/nvidia/nemo:24.09`)
- **ASR Model**: NVIDIA Parakeet (configurable: rnnt, ctc, or tdt variants)
- **Trigger**: Lambda (Python 3.12) via S3 event notifications
- **Transcription Server**: Python gRPC server with multiprocessing worker pool
- **Protocol**: gRPC with protobuf (`proto/transcribe.proto`)
- **Worker Management**: Batched loading (2 at a time) to prevent RAM spikes, Manager Queue for robust IPC

## Key Files

| File | Purpose |
|------|---------|
| `lib/parakeet-poc-stack.ts` | CDK infrastructure definition (dual-path, NLB + gRPC) |
| `bin/parakeet-poc.ts` | CDK app entry point, model selection |
| `scripts/transcribe_grpc.py` | Transcription gRPC server (configurable chunks) |
| `proto/transcribe.proto` | gRPC service definition |
| `lambda/index_grpc.py` | S3 trigger handler (gRPC client, routes by prefix) |
| `lambda-layer/` | Lambda layer with gRPC dependencies |

## Supported Audio Formats

- `.wav`
- `.mp3`

## Model Variants

Configure in `bin/parakeet-poc.ts`:
- `nvidia/parakeet-ctc-0.6b` - Smallest, fastest, lowest memory (~0.6GB)
- `nvidia/parakeet-rnnt-1.1b` - Faster inference
- `nvidia/parakeet-ctc-1.1b` - Alternative architecture
- `nvidia/parakeet-tdt-1.1b` - Best accuracy

**Note:** FP16 is disabled by default due to precision issues with smaller models and RNNT long-sequence decoding.
