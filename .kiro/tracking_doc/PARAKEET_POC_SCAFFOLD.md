# Parakeet ASR PoC - Initial Scaffold

## Status

- [x] Project structure created
- [x] CDK infrastructure defined
- [x] Refactored to always-on ECS Service with ALB
- [x] Lambda triggers transcription via HTTP API
- [ ] Deployment (pending user action)
- [ ] End-to-end testing with 50-min audio

## File Updates

- [x] `parakeet-poc/cdk.json` - CDK app configuration
- [x] `parakeet-poc/package.json` - Node dependencies
- [x] `parakeet-poc/tsconfig.json` - TypeScript config
- [x] `parakeet-poc/bin/parakeet-poc.ts` - CDK app entry point with model config
- [x] `parakeet-poc/lib/parakeet-poc-stack.ts` - ECS Service + ALB + Lambda in VPC
- [x] `parakeet-poc/lambda/index.py` - Calls ECS service via HTTP on S3 upload
- [x] `parakeet-poc/scripts/transcribe.py` - HTTP server with model preloaded
- [x] `parakeet-poc/README.md` - Usage documentation

## Outcome

- [x] Always-on ECS Service (model stays warm, no cold start)
- [x] Internal ALB for Lambda → ECS communication
- [x] S3 upload triggers Lambda → HTTP POST to /transcribe
- [x] g4dn.xlarge GPU instance with ECS-optimized AMI
- [x] Easy model switching via `parakeetModel` prop
- [x] Timing metrics in output JSON for benchmarking

## Notes

- User VPC: `vpc-0d6c5654761cfd6fd` (us-east-1)
- Default model: `nvidia/parakeet-rnnt-1.1b`
- Container startup still ~20min (image pull + model load), but only once
- Subsequent transcriptions are fast - model already in memory
