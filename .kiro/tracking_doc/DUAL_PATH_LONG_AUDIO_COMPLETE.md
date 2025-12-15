# Dual-Path Architecture for Long Audio Support

## Status

- [x] Implement dual-path architecture with two ECS services
- [x] Add configurable chunk duration parameter
- [x] Add max audio duration validation
- [x] Update Lambda to route by S3 prefix
- [x] Update documentation

## File Updates

- [x] `parakeet-poc/lib/parakeet-poc-stack.ts` - Refactored to create two ECS services (standard + long-audio) with configurable instance types and chunk sizes
- [x] `parakeet-poc/scripts/transcribe.py` - Added CHUNK_DURATION and MAX_AUDIO_DURATION_MINUTES env vars, duration validation
- [x] `parakeet-poc/lambda/index.py` - Routes to correct service based on S3 prefix (input/ vs input-long/)
- [x] `parakeet-poc/README.md` - Updated with dual-path architecture documentation
- [x] `.kiro/steering/project-overview.md` - Updated architecture diagram and service configs
- [x] `.kiro/steering/development-guide.md` - Updated testing commands for both paths

## Outcome

- [x] `input/` prefix → g4dn.2xlarge (T4), 30s chunks, max 30 min audio
- [x] `input-long/` prefix → g5.4xlarge (A10G), no chunking (full audio), max 60 min audio
- [x] Audio duration validation with clear error messages
- [x] Health endpoint reports service configuration

## Notes

- Both services share the same ECS cluster, log group, and S3 bucket
- g5.4xlarge has A10G GPU (24GB VRAM) vs T4 (16GB) for full audio processing
- CHUNK_DURATION=0 disables chunking and processes entire audio file
- Max duration configurable via MAX_AUDIO_DURATION_MINUTES env var
