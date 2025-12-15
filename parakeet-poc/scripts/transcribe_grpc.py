#!/usr/bin/env python3
"""
Parakeet transcription gRPC server for ECS.
Runs as gRPC server, receives S3 keys, transcribes in configurable chunks, uploads results.
Model stays loaded in memory for fast processing.

gRPC provides significantly better performance than HTTP for this use case:
- Binary protocol with efficient serialization (protobuf)
- HTTP/2 multiplexing and streaming
- Lower latency and reduced overhead

Environment variables:
  - CHUNK_DURATION: Chunk size in seconds (default: 30)
  - MAX_AUDIO_DURATION_MINUTES: Maximum audio length in minutes (default: 60)
  - PARAKEET_MODEL: Model name (default: nvidia/parakeet-rnnt-1.1b)
  - S3_BUCKET: S3 bucket name
  - GRPC_PORT: gRPC server port (default: 50051)
"""
import os
import json
import time
import boto3
import tempfile
import subprocess
from concurrent import futures
import grpc
import nemo.collections.asr as nemo_asr

# Import generated protobuf classes
import transcribe_pb2
import transcribe_pb2_grpc

# Global model - loaded once at startup
MODEL = None
MODEL_NAME = None
S3_CLIENT = boto3.client('s3')
BUCKET = os.environ['S3_BUCKET']

# Configurable parameters from environment
CHUNK_DURATION = int(os.environ.get('CHUNK_DURATION', '30'))
MAX_AUDIO_DURATION_MINUTES = int(os.environ.get('MAX_AUDIO_DURATION_MINUTES', '60'))
MAX_AUDIO_DURATION_SECONDS = MAX_AUDIO_DURATION_MINUTES * 60


def load_model():
    """Load model at startup - always load regardless of chunking mode."""
    global MODEL, MODEL_NAME
    import torch
    
    MODEL_NAME = os.environ.get('PARAKEET_MODEL', 'nvidia/parakeet-rnnt-1.1b')
    chunk_mode = "disabled (full audio)" if CHUNK_DURATION == 0 else f"{CHUNK_DURATION}s chunks"
    print(f"Config: chunking={chunk_mode}, max_audio={MAX_AUDIO_DURATION_MINUTES}min", flush=True)
    
    print(f"Loading model: {MODEL_NAME}...", flush=True)
    start = time.time()
    torch.cuda.empty_cache()
    MODEL = nemo_asr.models.ASRModel.from_pretrained(MODEL_NAME)
    MODEL.eval()
    print(f"Model loaded in {time.time() - start:.2f}s", flush=True)


def get_or_load_model():
    """Get the pre-loaded model."""
    global MODEL
    if MODEL is None:
        raise RuntimeError("Model not loaded - call load_model() first")
    return MODEL


def get_audio_duration(audio_path: str) -> float:
    """Get audio duration in seconds using ffprobe."""
    cmd = [
        'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', audio_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return float(result.stdout.strip())


def split_audio(audio_path: str, chunk_duration: int = None) -> list:
    """Split audio into chunks and return list of chunk file paths."""
    if chunk_duration is None:
        chunk_duration = CHUNK_DURATION
    
    duration = get_audio_duration(audio_path)
    chunks = []
    base_name = os.path.splitext(os.path.basename(audio_path))[0]
    temp_dir = tempfile.mkdtemp()
    
    start_time = 0
    chunk_idx = 0
    
    while start_time < duration:
        chunk_path = os.path.join(temp_dir, f"{base_name}_chunk_{chunk_idx:04d}.wav")
        cmd = [
            'ffmpeg', '-y', '-i', audio_path,
            '-ss', str(start_time), '-t', str(chunk_duration),
            '-ar', '16000', '-ac', '1', chunk_path
        ]
        subprocess.run(cmd, capture_output=True)
        
        if os.path.exists(chunk_path) and os.path.getsize(chunk_path) > 0:
            chunks.append({
                'path': chunk_path,
                'start_time': start_time,
                'end_time': min(start_time + chunk_duration, duration),
                'index': chunk_idx
            })
        
        start_time += chunk_duration
        chunk_idx += 1
    
    print(f"Split audio into {len(chunks)} chunks of {chunk_duration}s each", flush=True)
    return chunks


def prepare_audio(audio_path: str) -> str:
    """Convert audio to 16kHz mono WAV for ASR processing."""
    output_path = audio_path.rsplit('.', 1)[0] + '_prepared.wav'
    cmd = ['ffmpeg', '-y', '-i', audio_path, '-ar', '16000', '-ac', '1', output_path]
    subprocess.run(cmd, capture_output=True)
    return output_path


def extract_text(result) -> str:
    """Safely extract text string from NeMo transcribe result."""
    if not result:
        return ''
    text = result[0] if isinstance(result, list) else result
    while isinstance(text, list):
        text = text[0] if text else ''
    return str(text) if text else ''


def get_memory_stats() -> dict:
    """Get current GPU and system memory statistics."""
    import torch
    import psutil
    
    stats = {
        'system_ram_used_gb': round(psutil.virtual_memory().used / 1e9, 2),
        'system_ram_total_gb': round(psutil.virtual_memory().total / 1e9, 2),
        'system_ram_percent': psutil.virtual_memory().percent,
    }
    
    if torch.cuda.is_available():
        stats.update({
            'gpu_allocated_gb': round(torch.cuda.memory_allocated() / 1e9, 2),
            'gpu_reserved_gb': round(torch.cuda.memory_reserved() / 1e9, 2),
            'gpu_max_allocated_gb': round(torch.cuda.max_memory_allocated() / 1e9, 2),
            'gpu_total_gb': round(torch.cuda.get_device_properties(0).total_memory / 1e9, 2),
        })
    
    return stats


def log_memory(label: str):
    """Log memory stats with a label."""
    stats = get_memory_stats()
    gpu_info = f"GPU: {stats.get('gpu_allocated_gb', 0):.2f}/{stats.get('gpu_total_gb', 0):.2f}GB"
    ram_info = f"RAM: {stats['system_ram_used_gb']:.1f}/{stats['system_ram_total_gb']:.1f}GB ({stats['system_ram_percent']}%)"
    print(f"[MEMORY] {label}: {gpu_info} | {ram_info}", flush=True)


def transcribe_buffered(audio_path: str, model) -> tuple:
    """Transcribe long audio using NeMo's buffered/streaming approach."""
    import torch
    import numpy as np
    import soundfile as sf
    from nemo.collections.asr.parts.utils.streaming_utils import FrameBatchASR
    
    audio_data, sample_rate = sf.read(audio_path)
    if sample_rate != 16000:
        raise ValueError(f"Audio must be 16kHz, got {sample_rate}Hz")
    
    total_duration = len(audio_data) / sample_rate
    print(f"Buffered transcription: {total_duration:.1f}s audio", flush=True)
    
    frame_len = 1.6
    total_buffer = 4.0
    batch_size = 32
    
    try:
        streaming_asr = FrameBatchASR(
            asr_model=model, frame_len=frame_len,
            total_buffer=total_buffer, batch_size=batch_size,
        )
        streaming_asr.reset()
        
        chunk_size = int(30 * sample_rate)
        all_text = []
        segments = []
        
        for i in range(0, len(audio_data), chunk_size):
            chunk = audio_data[i:i + chunk_size]
            chunk_start_time = i / sample_rate
            chunk_end_time = min((i + len(chunk)) / sample_rate, total_duration)
            
            streaming_asr.add_audio(chunk)
            text = streaming_asr.transcribe()
            
            if text and text.strip():
                all_text.append(text.strip())
                segments.append({
                    'index': len(segments),
                    'start_time': chunk_start_time,
                    'end_time': chunk_end_time,
                    'text': text.strip(),
                })
            log_memory(f"Buffered chunk {len(segments)}")
        
        final_text = streaming_asr.transcribe(finish=True)
        if final_text and final_text.strip() and final_text.strip() not in all_text:
            all_text.append(final_text.strip())
        
        return ' '.join(all_text), segments
        
    except Exception as e:
        print(f"Buffered transcription failed: {e}, falling back to standard", flush=True)
        result = model.transcribe([audio_path])
        full_text = extract_text(result)
        return full_text, [{'index': 0, 'start_time': 0, 'end_time': total_duration, 'text': full_text}]


def transcribe(input_key: str) -> dict:
    """Download audio, validate duration, optionally split into chunks, transcribe."""
    import torch
    import gc
    
    # Release GPU memory before starting transcription
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    
    base_name = os.path.splitext(os.path.basename(input_key))[0]
    output_key = f"output/{base_name}_transcript.json"
    local_audio = f"/tmp/{os.path.basename(input_key)}"
    
    print(f"Processing: s3://{BUCKET}/{input_key}", flush=True)
    log_memory("Start (after GPU cleanup)")
    
    # Download
    download_start = time.time()
    S3_CLIENT.download_file(BUCKET, input_key, local_audio)
    download_time = time.time() - download_start
    print(f"Downloaded in {download_time:.2f}s", flush=True)
    log_memory("After download")
    
    # Get total duration and validate
    total_duration = get_audio_duration(local_audio)
    print(f"Audio duration: {total_duration:.1f}s ({total_duration/60:.1f} min)", flush=True)
    
    if total_duration > MAX_AUDIO_DURATION_SECONDS:
        os.remove(local_audio)
        raise ValueError(
            f"Audio duration ({total_duration/60:.1f} min) exceeds maximum "
            f"allowed ({MAX_AUDIO_DURATION_MINUTES} min) for this service"
        )
    
    use_chunking = CHUNK_DURATION > 0
    
    if use_chunking:
        split_start = time.time()
        chunks = split_audio(local_audio)
        split_time = time.time() - split_start
        print(f"Split completed in {split_time:.2f}s", flush=True)
        
        transcribe_start = time.time()
        transcriptions = []
        model = get_or_load_model()
        log_memory("After model load")
        
        import torch
        import gc
        
        for i, chunk in enumerate(chunks):
            # Clear GPU cache before each chunk to prevent OOM
            gc.collect()
            torch.cuda.empty_cache()
            
            chunk_start = time.time()
            with torch.no_grad():
                with torch.inference_mode():
                    result = model.transcribe([chunk['path']])
            chunk_time = time.time() - chunk_start
            
            text = extract_text(result)
            transcriptions.append({
                'index': chunk['index'],
                'start_time': chunk['start_time'],
                'end_time': chunk['end_time'],
                'text': text,
                'processing_time': round(chunk_time, 2)
            })
            
            # Aggressive cleanup after each chunk
            del result
            gc.collect()
            torch.cuda.empty_cache()
            
            stats = get_memory_stats()
            print(f"  Chunk {i+1}/{len(chunks)}: {chunk_time:.2f}s | GPU: {stats.get('gpu_allocated_gb', 0):.2f}GB", flush=True)
            os.remove(chunk['path'])
        
        transcribe_time = time.time() - transcribe_start
        full_text = ' '.join([t['text'] for t in transcriptions if t['text']])
        num_chunks = len(chunks)
    else:
        split_time = 0.0
        print(f"Processing full audio (buffered streaming mode)...", flush=True)
        
        prep_start = time.time()
        prepared_audio = prepare_audio(local_audio)
        split_time = time.time() - prep_start
        print(f"Audio prepared in {split_time:.2f}s", flush=True)
        
        import torch
        import gc
        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        
        log_memory("Before model load")
        model = get_or_load_model()
        log_memory("After model load")
        
        transcribe_start = time.time()
        with torch.no_grad():
            with torch.inference_mode():
                full_text, transcriptions = transcribe_buffered(prepared_audio, model)
        transcribe_time = time.time() - transcribe_start
        
        for seg in transcriptions:
            seg['processing_time'] = round(transcribe_time / max(len(transcriptions), 1), 2)
        
        log_memory("After transcription")
        stats = get_memory_stats()
        print(f"GPU peak memory: {stats.get('gpu_max_allocated_gb', 0):.2f}GB", flush=True)
        
        num_chunks = len(transcriptions)
        if os.path.exists(prepared_audio):
            os.remove(prepared_audio)
    
    print(f"Transcription completed in {transcribe_time:.2f}s", flush=True)
    
    final_memory = get_memory_stats()
    log_memory("Final")
    
    result = {
        'input_file': input_key,
        'model': MODEL_NAME,
        'transcription': full_text,
        'segments': transcriptions,
        'audio_duration_seconds': round(total_duration, 2),
        'timing': {
            'download_seconds': round(download_time, 2),
            'prep_seconds': round(split_time, 2),
            'transcription_seconds': round(transcribe_time, 2),
            'total_seconds': round(download_time + split_time + transcribe_time, 2),
        },
        'processing_config': {
            'chunking_enabled': use_chunking,
            'chunk_duration_seconds': CHUNK_DURATION if use_chunking else None,
            'total_chunks': num_chunks,
            'max_audio_duration_minutes': MAX_AUDIO_DURATION_MINUTES
        },
        'memory': {
            'gpu_peak_gb': final_memory.get('gpu_max_allocated_gb'),
            'gpu_total_gb': final_memory.get('gpu_total_gb'),
            'system_ram_used_gb': final_memory.get('system_ram_used_gb'),
            'system_ram_total_gb': final_memory.get('system_ram_total_gb'),
        }
    }
    
    # Upload result to S3
    S3_CLIENT.put_object(
        Bucket=BUCKET, Key=output_key,
        Body=json.dumps(result, indent=2),
        ContentType='application/json'
    )
    print(f"Result saved to s3://{BUCKET}/{output_key}", flush=True)
    
    os.remove(local_audio)
    return result


class TranscribeServicer(transcribe_pb2_grpc.TranscribeServiceServicer):
    """gRPC service implementation for transcription."""
    
    def Transcribe(self, request, context):
        """Handle transcription request."""
        input_key = request.input_key
        
        if not input_key:
            return transcribe_pb2.TranscribeResponse(error="input_key required")
        
        try:
            result = transcribe(input_key)
            
            # Log completion
            timing = result['timing']
            config = result['processing_config']
            memory = result.get('memory', {})
            print(f"=== TRANSCRIPTION COMPLETE (gRPC) ===", flush=True)
            print(f"  File: {input_key}", flush=True)
            print(f"  Audio duration: {result['audio_duration_seconds']}s", flush=True)
            print(f"  Chunking: {'enabled' if config['chunking_enabled'] else 'disabled (full audio)'}", flush=True)
            if config['chunking_enabled']:
                print(f"  Chunks: {config['total_chunks']} x {config['chunk_duration_seconds']}s", flush=True)
            print(f"  Download: {timing['download_seconds']}s", flush=True)
            print(f"  Prep: {timing['prep_seconds']}s", flush=True)
            print(f"  Transcription: {timing['transcription_seconds']}s", flush=True)
            print(f"  Total: {timing['total_seconds']}s", flush=True)
            print(f"  GPU Peak: {memory.get('gpu_peak_gb', 'N/A')}GB / {memory.get('gpu_total_gb', 'N/A')}GB", flush=True)
            print(f"======================================", flush=True)
            
            # Build protobuf response
            segments = [
                transcribe_pb2.Segment(
                    index=s['index'],
                    start_time=s['start_time'],
                    end_time=s['end_time'],
                    text=s['text'],
                    processing_time=s.get('processing_time', 0)
                )
                for s in result['segments']
            ]
            
            return transcribe_pb2.TranscribeResponse(
                input_file=result['input_file'],
                model=result['model'],
                transcription=result['transcription'],
                segments=segments,
                audio_duration_seconds=result['audio_duration_seconds'],
                timing=transcribe_pb2.Timing(
                    download_seconds=timing['download_seconds'],
                    prep_seconds=timing['prep_seconds'],
                    transcription_seconds=timing['transcription_seconds'],
                    total_seconds=timing['total_seconds'],
                ),
                processing_config=transcribe_pb2.ProcessingConfig(
                    chunking_enabled=config['chunking_enabled'],
                    chunk_duration_seconds=config['chunk_duration_seconds'] or 0,
                    total_chunks=config['total_chunks'],
                    max_audio_duration_minutes=config['max_audio_duration_minutes'],
                ),
                memory=transcribe_pb2.MemoryStats(
                    gpu_peak_gb=memory.get('gpu_peak_gb') or 0,
                    gpu_total_gb=memory.get('gpu_total_gb') or 0,
                    system_ram_used_gb=memory.get('system_ram_used_gb') or 0,
                    system_ram_total_gb=memory.get('system_ram_total_gb') or 0,
                ),
            )
            
        except ValueError as e:
            print(f"VALIDATION ERROR: {str(e)}", flush=True)
            context.set_code(grpc.StatusCode.INVALID_ARGUMENT)
            context.set_details(str(e))
            return transcribe_pb2.TranscribeResponse(error=str(e))
        except Exception as e:
            print(f"ERROR: {str(e)}", flush=True)
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return transcribe_pb2.TranscribeResponse(error=str(e))
    
    def HealthCheck(self, request, context):
        """Handle health check request."""
        return transcribe_pb2.HealthCheckResponse(
            status='healthy',
            model_loaded=MODEL is not None,
            config=transcribe_pb2.ProcessingConfig(
                chunking_enabled=CHUNK_DURATION > 0,
                chunk_duration_seconds=CHUNK_DURATION if CHUNK_DURATION > 0 else 0,
                total_chunks=0,
                max_audio_duration_minutes=MAX_AUDIO_DURATION_MINUTES,
            ),
        )


def serve():
    """Start the gRPC server."""
    load_model()
    
    port = int(os.environ.get('GRPC_PORT', '50051'))
    
    # Configure server with appropriate settings for long-running transcriptions
    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=4),
        options=[
            ('grpc.max_send_message_length', 100 * 1024 * 1024),  # 100MB
            ('grpc.max_receive_message_length', 100 * 1024 * 1024),  # 100MB
            ('grpc.keepalive_time_ms', 30000),  # 30s keepalive
            ('grpc.keepalive_timeout_ms', 10000),  # 10s timeout
            ('grpc.keepalive_permit_without_calls', True),
            ('grpc.http2.max_pings_without_data', 0),
        ]
    )
    
    transcribe_pb2_grpc.add_TranscribeServiceServicer_to_server(
        TranscribeServicer(), server
    )
    
    server.add_insecure_port(f'[::]:{port}')
    server.start()
    
    print(f"gRPC server running on port {port}", flush=True)
    print(f"Ready to process audio up to {MAX_AUDIO_DURATION_MINUTES} minutes", flush=True)
    
    server.wait_for_termination()


if __name__ == '__main__':
    serve()
