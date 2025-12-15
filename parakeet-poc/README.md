# Parakeet ASR PoC on ECS

Lightweight PoC for testing NVIDIA Parakeet speech-to-text on ECS with GPU using gRPC.

## Architecture

Dual-path architecture with gRPC over NLB for high-performance audio transcription:

```
S3 (input/)        → Lambda → NLB (gRPC) → ECS Standard (g4dn.2xlarge)  → S3 (output/)
S3 (input-nochunk/) → Lambda → NLB (gRPC) → ECS Long Audio (g5.2xlarge) → S3 (output/)
```

### Why gRPC?

- Binary protocol with efficient protobuf serialization
- HTTP/2 multiplexing and streaming
- Lower latency and reduced overhead vs REST/HTTP

### Service Configurations

| Prefix | Instance | GPU | Chunking | Max Audio | Use Case |
|--------|----------|-----|----------|-----------|----------|
| `input/` | g4dn.2xlarge | T4 (16GB) | 30s chunks | 60 min | Standard audio |
| `input-nochunk/` | g5.2xlarge | A10G (24GB) | 60s chunks | 60 min | Long audio |

## Prerequisites

- AWS CLI configured
- CDK CLI installed (`npm install -g aws-cdk`)
- Docker running (for building container image)
- NGC access for NeMo container (may need `docker login nvcr.io`)

## Deploy

```bash
cd parakeet-poc
npm install

# Build Lambda layer for gRPC (required before first deploy)
python3 -m venv .venv
.venv/bin/pip install grpcio-tools
./scripts/build-lambda-layer.sh

cdk bootstrap  # if first time
cdk deploy
```

## Usage

### Standard Audio

```bash
aws s3 cp your-audio.wav s3://parakeet-poc-<account>-us-east-1/input/
```

### Long Audio (larger chunks)

```bash
aws s3 cp your-long-audio.wav s3://parakeet-poc-<account>-us-east-1/input-nochunk/
```

### Check Output

```bash
aws s3 ls s3://parakeet-poc-<account>-us-east-1/output/
aws s3 cp s3://parakeet-poc-<account>-us-east-1/output/your-audio_transcript.json .
```

## Switch Models

Edit `bin/parakeet-poc.ts` and change `parakeetModel`:

```typescript
parakeetModel: 'nvidia/parakeet-ctc-0.6b',    // smaller, faster
// parakeetModel: 'nvidia/parakeet-rnnt-1.1b', // balanced
// parakeetModel: 'nvidia/parakeet-tdt-1.1b',  // best accuracy
```

Then redeploy: `cdk deploy`

## Monitor

```bash
# Watch ECS task logs
aws logs tail /ecs/parakeet-poc --follow

# Check running tasks
aws ecs list-tasks --cluster parakeet-poc-cluster
```

## Key Files

| File | Purpose |
|------|---------|
| `lib/parakeet-poc-stack.ts` | CDK infrastructure (NLB + gRPC) |
| `bin/parakeet-poc.ts` | CDK app entry, model selection |
| `scripts/transcribe_grpc.py` | gRPC transcription server |
| `proto/transcribe.proto` | gRPC service definition |
| `lambda/index_grpc.py` | S3 trigger Lambda (gRPC client) |

## Cleanup

```bash
cdk destroy
```

## Notes

- Supports `.wav` and `.mp3` files
- Output includes timing and memory metrics
- T4 GPU (16GB): use 30s chunks max
- A10G GPU (24GB): can handle 60s chunks
- Model loaded at startup for fast inference
