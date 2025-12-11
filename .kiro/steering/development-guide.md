<!---
  Development Guide - Always included
  inclusion: always
--->

# Development Guide

## Local Setup

```bash
cd parakeet-poc
npm install
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
# Upload audio
aws s3 cp your-audio.wav s3://parakeet-poc-<account>-us-east-1/input/

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
- Use `flush=True` on print statements in ECS container for real-time logs
- Transcription server uses chunked processing (30s segments) for memory efficiency

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
