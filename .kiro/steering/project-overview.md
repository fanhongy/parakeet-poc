<!---
  Project Overview - Always included in context
  inclusion: always
--->

# Parakeet ASR PoC

## Project Purpose

This is a proof-of-concept for running NVIDIA Parakeet speech-to-text models on AWS ECS with GPU acceleration. It demonstrates an event-driven architecture for audio transcription.

## Architecture

```
S3 (input/) → Lambda → ALB → ECS Service (GPU) → S3 (output/)
```

1. Audio files uploaded to S3 `input/` prefix trigger Lambda
2. Lambda calls internal ALB endpoint
3. ECS service (with GPU) transcribes audio in 30-second chunks
4. Results saved to S3 `output/` as JSON

## Tech Stack

- **Infrastructure**: AWS CDK (TypeScript)
- **Compute**: ECS on EC2 with g4dn.2xlarge (T4 GPU, 16GB VRAM)
- **Container**: NVIDIA NeMo 24.05 (`nvcr.io/nvidia/nemo:24.05`)
- **ASR Model**: NVIDIA Parakeet (configurable: rnnt, ctc, or tdt variants)
- **Trigger**: Lambda (Python 3.12) via S3 event notifications
- **Transcription Server**: Python HTTP server (`scripts/transcribe.py`)

## Key Files

| File | Purpose |
|------|---------|
| `lib/parakeet-poc-stack.ts` | CDK infrastructure definition |
| `bin/parakeet-poc.ts` | CDK app entry point, model selection |
| `scripts/transcribe.py` | Transcription HTTP server (runs on ECS) |
| `lambda/index.py` | S3 trigger handler |

## Supported Audio Formats

- `.wav`
- `.mp3`

## Model Variants

Configure in `bin/parakeet-poc.ts`:
- `nvidia/parakeet-rnnt-1.1b` - Default, faster inference
- `nvidia/parakeet-ctc-1.1b` - Alternative architecture
- `nvidia/parakeet-tdt-1.1b` - Best accuracy
