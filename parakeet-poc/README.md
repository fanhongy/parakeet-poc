# Parakeet ASR PoC on ECS

Lightweight PoC for testing NVIDIA Parakeet speech-to-text on ECS with GPU.

## Architecture

Dual-path architecture for different audio lengths:

```
S3 (input/)      → Lambda → ALB → ECS Standard (g4dn.2xlarge)  → S3 (output/)
S3 (input-long/) → Lambda → ALB → ECS Long Audio (g5.4xlarge) → S3 (output/)
```

### Service Configurations

| Prefix | Instance | GPU | Chunking | Max Audio | Use Case |
|--------|----------|-----|----------|-----------|----------|
| `input/` | g4dn.2xlarge | T4 (16GB) | 30s chunks | 30 min | Short/medium audio |
| `input-long/` | g5.4xlarge | A10G (24GB) | No chunking | 60 min | Long audio (full processing) |

## Prerequisites

- AWS CLI configured
- CDK CLI installed (`npm install -g aws-cdk`)
- Docker running (for building container image)
- NGC access for NeMo container (may need `docker login nvcr.io`)

## Deploy

```bash
cd parakeet-poc
npm install
cdk bootstrap  # if first time
cdk deploy
```

## Usage

### Standard Audio (up to 30 min)

```bash
aws s3 cp your-audio.wav s3://parakeet-poc-<account>-us-east-1/input/
```

### Long Audio (up to 60 min)

```bash
aws s3 cp your-long-audio.wav s3://parakeet-poc-<account>-us-east-1/input-long/
```

### Check Output

```bash
aws s3 ls s3://parakeet-poc-<account>-us-east-1/output/
aws s3 cp s3://parakeet-poc-<account>-us-east-1/output/your-audio_transcript.json .
```

## Switch Models

Edit `bin/parakeet-poc.ts` and change `parakeetModel`:

```typescript
parakeetModel: 'nvidia/parakeet-rnnt-1.1b',  // faster
// parakeetModel: 'nvidia/parakeet-ctc-1.1b',
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

## Cleanup

```bash
cdk destroy
```

## Notes

- Supports `.wav` and `.mp3` files
- Output includes timing metrics for benchmarking
- Standard service: g4dn.2xlarge (T4 GPU, 16GB VRAM)
- Long audio service: g5.4xlarge (A10G GPU, 24GB VRAM)
- Chunk size is configurable per service for memory efficiency
