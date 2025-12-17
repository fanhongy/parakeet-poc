#!/usr/bin/env python3
"""
Parakeet transcription gRPC server for ECS.
Uses multiprocessing for true parallel inference - each worker has its own model copy.

Environment variables:
  - CHUNK_DURATION: Chunk size in seconds (default: 30)
  - MAX_AUDIO_DURATION_MINUTES: Maximum audio length in minutes (default: 60)
  - PARAKEET_MODEL: Model name (default: nvidia/parakeet-rnnt-1.1b)
  - S3_BUCKET: S3 bucket name
  - GRPC_PORT: gRPC server port (default: 50051)
  - NUM_WORKERS: Number of worker processes (default: 2)
"""
import os
import json
import time
import boto3
import tempfile
import subprocess
import multiprocessing as mp
from concurrent import futures
import grpc
import threading

# Import generated protobuf classes
import transcribe_pb2
import transcribe_pb2_grpc

# Configurable parameters
CHUNK_DURATION = int(os.environ.get('CHUNK_DURATION', '30'))
MAX_AUDIO_DURATION_MINUTES = int(os.environ.get('MAX_AUDIO_DURATION_MINUTES', '60'))
MAX_AUDIO_DURATION_SECONDS = MAX_AUDIO_DURATION_MINUTES * 60
NUM_WORKERS = int(os.environ.get('NUM_WORKERS', '2'))

# Global manager - must be created before fork/spawn
_manager = None

def get_manager():
    """Get or create the global multiprocessing manager."""
    global _manager
    if _manager is None:
        _manager = mp.Manager()
    return _manager


def get_audio_duration(audio_path: str) -> float:
    """Get audio duration in seconds using ffprobe."""
    cmd = [
        'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', audio_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return float(result.stdout.strip())


def split_audio(audio_path: str, chunk_duration: int) -> list:
    """Split audio into chunks."""
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
    
    return chunks


def extract_text(result) -> str:
    """Safely extract text from NeMo result."""
    if not result:
        return ''
    text = result[0] if isinstance(result, list) else result
    while isinstance(text, list):
        text = text[0] if text else ''
    return str(text) if text else ''


# =============================================================================
# Worker Process
# =============================================================================

def worker_process(worker_id: int, request_queue, response_dict, model_name: str, 
                   bucket: str, chunk_duration: int, max_duration: int, use_fp16: bool):
    """Worker process that loads its own model and processes requests."""
    import torch
    import gc
    import nemo.collections.asr as nemo_asr
    
    if torch.cuda.is_available():
        torch.cuda.set_device(0)
    
    print(f"[Worker {worker_id}] Starting, loading model: {model_name}...", flush=True)
    start = time.time()
    
    torch.cuda.empty_cache()
    model = nemo_asr.models.ASRModel.from_pretrained(model_name)
    model.eval()
    
    if use_fp16 and torch.cuda.is_available():
        model = model.half()
    
    if torch.cuda.is_available():
        allocated = torch.cuda.memory_allocated() / 1e9
        total = torch.cuda.get_device_properties(0).total_memory / 1e9
        print(f"[Worker {worker_id}] Model loaded in {time.time() - start:.2f}s, GPU: {allocated:.2f}/{total:.2f}GB", flush=True)
    else:
        print(f"[Worker {worker_id}] Model loaded in {time.time() - start:.2f}s (CPU mode)", flush=True)
    
    s3_client = boto3.client('s3')
    
    print(f"[Worker {worker_id}] Ready for requests", flush=True)
    
    while True:
        try:
            request = request_queue.get()
            
            if request is None:
                print(f"[Worker {worker_id}] Shutting down", flush=True)
                break
            
            request_id = request['request_id']
            input_key = request['input_key']
            
            print(f"[Worker {worker_id}] Processing request #{request_id}: {input_key}", flush=True)
            
            try:
                result = process_transcription(
                    worker_id, model, s3_client, bucket, input_key,
                    chunk_duration, max_duration, model_name
                )
                response_dict[request_id] = {'result': result, 'error': None, 'done': True}
                
            except Exception as e:
                import traceback
                print(f"[Worker {worker_id}] Error processing #{request_id}: {e}", flush=True)
                traceback.print_exc()
                response_dict[request_id] = {'result': None, 'error': str(e), 'done': True}
                
        except Exception as e:
            print(f"[Worker {worker_id}] Queue error: {e}", flush=True)


def process_transcription(worker_id: int, model, s3_client, bucket: str, 
                          input_key: str, chunk_duration: int, max_duration: int,
                          model_name: str) -> dict:
    """Process a single transcription request."""
    import torch
    import gc
    
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    
    base_name = os.path.splitext(os.path.basename(input_key))[0]
    output_key = f"output/{base_name}_transcript.json"
    local_audio = f"/tmp/worker{worker_id}_{os.path.basename(input_key)}"
    
    download_start = time.time()
    s3_client.download_file(bucket, input_key, local_audio)
    download_time = time.time() - download_start
    print(f"[Worker {worker_id}] Downloaded in {download_time:.2f}s", flush=True)
    
    total_duration = get_audio_duration(local_audio)
    print(f"[Worker {worker_id}] Audio duration: {total_duration:.1f}s", flush=True)
    
    if total_duration > max_duration:
        os.remove(local_audio)
        raise ValueError(f"Audio too long: {total_duration/60:.1f} min > {max_duration/60:.0f} min max")
    
    split_start = time.time()
    chunks = split_audio(local_audio, chunk_duration)
    split_time = time.time() - split_start
    print(f"[Worker {worker_id}] Split into {len(chunks)} chunks in {split_time:.2f}s", flush=True)
    
    transcribe_start = time.time()
    transcriptions = []
    
    for i, chunk in enumerate(chunks):
        gc.collect()
        torch.cuda.empty_cache()
        
        chunk_start = time.time()
        with torch.no_grad():
            with torch.inference_mode():
                result = model.transcribe([chunk['path']], batch_size=1, verbose=False)
        chunk_time = time.time() - chunk_start
        
        text = extract_text(result)
        transcriptions.append({
            'index': chunk['index'],
            'start_time': chunk['start_time'],
            'end_time': chunk['end_time'],
            'text': text,
            'processing_time': round(chunk_time, 2)
        })
        
        del result
        
        if torch.cuda.is_available():
            gpu_gb = torch.cuda.memory_allocated() / 1e9
            print(f"[Worker {worker_id}]   Chunk {i+1}/{len(chunks)}: {chunk_time:.2f}s | GPU: {gpu_gb:.2f}GB", flush=True)
        
        os.remove(chunk['path'])
    
    transcribe_time = time.time() - transcribe_start
    full_text = ' '.join([t['text'] for t in transcriptions if t['text']])
    
    print(f"[Worker {worker_id}] Transcription completed in {transcribe_time:.2f}s", flush=True)
    
    memory = {}
    if torch.cuda.is_available():
        memory = {
            'gpu_peak_gb': round(torch.cuda.max_memory_allocated() / 1e9, 2),
            'gpu_total_gb': round(torch.cuda.get_device_properties(0).total_memory / 1e9, 2),
        }
    
    result = {
        'input_file': input_key,
        'model': model_name,
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
            'chunking_enabled': True,
            'chunk_duration_seconds': chunk_duration,
            'total_chunks': len(chunks),
        },
        'memory': memory,
        'worker_id': worker_id,
    }
    
    s3_client.put_object(
        Bucket=bucket, Key=output_key,
        Body=json.dumps(result, indent=2),
        ContentType='application/json'
    )
    print(f"[Worker {worker_id}] Result saved to s3://{bucket}/{output_key}", flush=True)
    
    os.remove(local_audio)
    return result


# =============================================================================
# gRPC Service
# =============================================================================

class TranscribeServicer(transcribe_pb2_grpc.TranscribeServiceServicer):
    """gRPC service that dispatches requests to worker pool."""
    
    def __init__(self, request_queue, response_dict):
        self.request_queue = request_queue
        self.response_dict = response_dict
        self.request_counter = 0
        self.counter_lock = threading.Lock()
    
    def Transcribe(self, request, context):
        """Handle transcription request by dispatching to worker pool."""
        input_key = request.input_key
        
        if not input_key:
            return transcribe_pb2.TranscribeResponse(error="input_key required")
        
        with self.counter_lock:
            self.request_counter += 1
            request_id = self.request_counter
        
        print(f"[gRPC] Request #{request_id} received: {input_key}", flush=True)
        
        # Initialize response slot
        self.response_dict[request_id] = {'done': False}
        
        # Submit to worker pool
        self.request_queue.put({
            'request_id': request_id,
            'input_key': input_key,
        })
        
        # Poll for response
        timeout = 600  # 10 min
        start = time.time()
        while time.time() - start < timeout:
            if self.response_dict.get(request_id, {}).get('done'):
                break
            time.sleep(0.1)
        
        response = self.response_dict.get(request_id, {})
        
        # Cleanup
        if request_id in self.response_dict:
            del self.response_dict[request_id]
        
        if not response.get('done'):
            print(f"[gRPC] Request #{request_id} timeout", flush=True)
            return transcribe_pb2.TranscribeResponse(error="Processing timeout")
        
        if response.get('error'):
            print(f"[gRPC] Request #{request_id} failed: {response['error']}", flush=True)
            return transcribe_pb2.TranscribeResponse(error=response['error'])
        
        result = response['result']
        timing = result['timing']
        config = result['processing_config']
        memory = result.get('memory', {})
        
        print(f"[gRPC] Request #{request_id} complete: {result['audio_duration_seconds']}s audio in {timing['total_seconds']}s (worker {result.get('worker_id', '?')})", flush=True)
        
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
                max_audio_duration_minutes=MAX_AUDIO_DURATION_MINUTES,
            ),
            memory=transcribe_pb2.MemoryStats(
                gpu_peak_gb=memory.get('gpu_peak_gb') or 0,
                gpu_total_gb=memory.get('gpu_total_gb') or 0,
                system_ram_used_gb=0,
                system_ram_total_gb=0,
            ),
        )


def serve():
    """Start worker pool and gRPC server."""
    bucket = os.environ['S3_BUCKET']
    model_name = os.environ.get('PARAKEET_MODEL', 'nvidia/parakeet-rnnt-1.1b')
    use_fp16 = os.environ.get('USE_FP16', 'true').lower() == 'true'
    port = os.environ.get('GRPC_PORT', '50051')
    
    print(f"=== Parakeet ASR Server (Process Pool) ===", flush=True)
    print(f"Model: {model_name}", flush=True)
    print(f"Workers: {NUM_WORKERS}", flush=True)
    print(f"Chunk duration: {CHUNK_DURATION}s", flush=True)
    print(f"Max audio: {MAX_AUDIO_DURATION_MINUTES} min", flush=True)
    print(f"FP16: {use_fp16}", flush=True)
    print(f"==========================================", flush=True)
    
    # Use mp.Queue directly (works with spawn) for request queue
    # Use Manager dict for responses (needs to be shared dict)
    request_queue = mp.Queue()
    manager = get_manager()
    response_dict = manager.dict()
    
    # Start worker processes
    workers = []
    for i in range(NUM_WORKERS):
        p = mp.Process(
            target=worker_process,
            args=(i, request_queue, response_dict, model_name, bucket, 
                  CHUNK_DURATION, MAX_AUDIO_DURATION_SECONDS, use_fp16),
        )
        p.start()
        workers.append(p)
        print(f"Started worker {i} (PID: {p.pid})", flush=True)
    
    print("Waiting for workers to load models...", flush=True)
    time.sleep(5)
    
    # Start gRPC server
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    transcribe_pb2_grpc.add_TranscribeServiceServicer_to_server(
        TranscribeServicer(request_queue, response_dict), server
    )
    server.add_insecure_port(f'[::]:{port}')
    server.start()
    
    print(f"gRPC server running on port {port}", flush=True)
    print(f"Ready to process {NUM_WORKERS} requests in parallel", flush=True)
    
    try:
        server.wait_for_termination()
    except KeyboardInterrupt:
        print("Shutting down...", flush=True)
        for _ in workers:
            request_queue.put(None)
        for w in workers:
            w.join(timeout=5)


if __name__ == '__main__':
    # Set spawn method before creating any multiprocessing objects
    mp.set_start_method('spawn', force=True)
    serve()
