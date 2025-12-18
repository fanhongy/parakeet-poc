<!---
  Development Guide - Always included
  inclusion: always
--->

# Development Guide

## Local Setup

```bash
cd parakeet-poc
npm install

# Build Lambda layer for gRPC (required before first deploy)
python3 -m venv .venv
.venv/bin/pip install grpcio-tools
./scripts/build-lambda-layer.sh
```

## Deployment Commands

```bash
cdk bootstrap          # First time only
cdk deploy             # Deploy stack
cdk destroy            # Tear down
cdk diff               # Preview changes
```

## Testing Transcription

```bash
# Standard audio (up to 30 min, 30s chunks)
aws s3 cp your-audio.wav s3://parakeet-poc-<account>-us-east-1/input/

# Long audio (up to 60 min, no chunking - full audio processing)
aws s3 cp your-long-audio.wav s3://parakeet-poc-<account>-us-east-1/input-long/

# Check output
aws s3 ls s3://parakeet-poc-<account>-us-east-1/output/
aws s3 cp s3://parakeet-poc-<account>-us-east-1/output/your-audio_transcript.json .
```

## Monitoring

```bash
# ECS task logs
aws logs tail /ecs/parakeet-poc --follow

# Running tasks
aws ecs list-tasks --cluster parakeet-poc-cluster
```

## Changing Models

Edit `bin/parakeet-poc.ts`, update `parakeetModel`, then `cdk deploy`.

## Code Conventions

- CDK infrastructure in TypeScript (`lib/`, `bin/`)
- Runtime code in Python (`scripts/`, `lambda/`)
- gRPC service definition in `proto/transcribe.proto`
- Use `flush=True` on print statements in ECS container for real-time logs
- Transcription server: gRPC over NLB (port 50051)
- Chunked (30s) for standard, full audio for long-audio service

## Worker Configuration

The transcription server uses multiprocessing with configurable workers:

**Environment Variables:**
- `NUM_WORKERS` - Number of parallel worker processes (default: 2)
- `WORKER_BATCH_SIZE` - Workers loaded per batch to prevent RAM spike (default: 2)
- `CHUNK_DURATION` - Audio chunk size in seconds (default: 30)
- `MAX_AUDIO_DURATION_MINUTES` - Maximum audio length (default: 60)
- `USE_FP16` - Half-precision inference (default: false, see note below)

**FP16 Precision Warning:**
FP16 (half-precision) is **disabled by default** because it causes issues with Parakeet models:
- **CTC-0.6b**: FP16 corrupts model weights, producing `⁇` garbage output
- **RNNT-1.1b**: FP16 causes CUDA illegal memory access errors on long audio chunks (600s+)

Only enable FP16 if you've tested thoroughly with your specific model and chunk configuration.

**Worker Startup:**
- Workers load in batches (e.g., 2 at a time) to avoid memory pressure
- Each worker loads its own model copy (~1.3GB GPU memory per worker)
- 3-second pause between batches for memory stabilization
- Workers signal readiness via multiprocessing Events

**Queue Management:**
- Uses `multiprocessing.Manager().Queue()` for robust IPC
- Manager queues survive extended idle periods better than raw `mp.Queue()`
- gRPC server monitors worker health and reports alive worker count

## Updating Proto Definition

After modifying `proto/transcribe.proto`, regenerate Python files:
```bash
./scripts/build-lambda-layer.sh
```

## Output JSON Structure

```json
{
  "input_file": "input/audio.wav",
  "model": "nvidia/parakeet-rnnt-1.1b",
  "transcription": "full text...",
  "segments": [
    {"index": 0, "start_time": 0, "end_time": 30, "text": "..."}
  ],
  "audio_duration_seconds": 180.5,
  "timing": {
    "download_seconds": 1.2,
    "split_seconds": 0.8,
    "transcription_seconds": 45.3,
    "total_seconds": 47.3
  }
}
```
