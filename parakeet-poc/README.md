# Parakeet ASR PoC on ECS

Lightweight PoC for testing NVIDIA Parakeet speech-to-text on ECS with GPU.

## Architecture

```
S3 (input/) → Lambda → ECS Task (GPU) → S3 (output/)
```

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

Upload audio to trigger transcription:

```bash
aws s3 cp your-audio.wav s3://parakeet-poc-<account>-us-east-1/input/
```

Check output:

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

- Supports `.wav` and `.mp3` files in `input/` prefix
- Output includes timing metrics for benchmarking
- g4dn.xlarge provides 1x T4 GPU (16GB VRAM)
- For 50-min audio, expect ~5-15 min processing depending on model


## Record: 

December 8, 2025, 16:51:02 (UTC+11:00)
December 8, 2025, 16:52:02 (UTC+11:00)

December 8, 2025, 17:24:55 (UTC+11:00)
December 8, 2025, 17:24:56 (UTC+11:00)


2025-12-09T14:07:11.076+11:00
2025-12-09T14:08:41.442+11:00