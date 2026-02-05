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
  - ENABLE_EMF_METRICS: Enable CloudWatch EMF metrics (default: true)
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
import sys

# Import generated protobuf classes
import transcribe_pb2
import transcribe_pb2_grpc

# Configurable parameters
CHUNK_DURATION = int(os.environ.get('CHUNK_DURATION', '30'))
MAX_AUDIO_DURATION_MINUTES = int(os.environ.get('MAX_AUDIO_DURATION_MINUTES', '60'))
MAX_AUDIO_DURATION_SECONDS = MAX_AUDIO_DURATION_MINUTES * 60
NUM_WORKERS = int(os.environ.get('NUM_WORKERS', '2'))
ENABLE_EMF_METRICS = os.environ.get('ENABLE_EMF_METRICS', 'true').lower() == 'true'


# =============================================================================
# CloudWatch EMF Metrics
# =============================================================================

def emit_emf_metric(namespace: str, metrics: dict, dimensions: dict, properties: dict = None):
    """
    Emit CloudWatch Embedded Metric Format (EMF) log.
    
    EMF logs are automatically parsed by CloudWatch Logs agent and converted to metrics.
    Format: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
    """
    if not ENABLE_EMF_METRICS:
        return
    
    # Build metric definitions
    metric_definitions = []
    for name, value in metrics.items():
        unit = "None"
        if "Percent" in name or "Utilization" in name:
            unit = "Percent"
        elif "Seconds" in name or "Time" in name or "Duration" in name:
            unit = "Seconds"
        elif "Bytes" in name:
            unit = "Bytes"
        elif "Count" in name:
            unit = "Count"
        elif "GB" in name:
            unit = "Gigabytes"
        metric_definitions.append({"Name": name, "Unit": unit})
    
    # Build EMF structure
    emf_log = {
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [{
                "Namespace": namespace,
                "Dimensions": [list(dimensions.keys())],
                "Metrics": metric_definitions
            }]
        }
    }
    
    # Add dimensions and metrics as top-level keys
    emf_log.update(dimensions)
    emf_log.update(metrics)
    
    # Add optional properties (not indexed as metrics)
    if properties:
        emf_log.update(properties)
    
    # Print to stdout - CloudWatch Logs agent picks this up
    print(json.dumps(emf_log), flush=True)


def get_gpu_utilization() -> dict:
    """Get current GPU utilization using nvidia-smi."""
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=utilization.gpu,utilization.memory,memory.used,memory.total',
             '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            parts = result.stdout.strip().split(',')
            return {
                'gpu_util_percent': float(parts[0].strip()),
                'memory_util_percent': float(parts[1].strip()),
                'memory_used_mb': float(parts[2].strip()),
                'memory_total_mb': float(parts[3].strip()),
            }
    except Exception:
        pass
    return {}


def emit_chunk_metrics(worker_id: int, chunk_index: int, total_chunks: int,
                       chunk_duration_audio: float, processing_time: float,
                       model_name: str, input_key: str):
    """Emit metrics for a single chunk processing."""
    gpu_stats = get_gpu_utilization()
    
    # Calculate real-time factor (RTF): processing_time / audio_duration
    # RTF < 1 means faster than real-time
    rtf = processing_time / chunk_duration_audio if chunk_duration_audio > 0 else 0
    
    metrics = {
        "ChunkProcessingSeconds": round(processing_time, 3),
        "ChunkAudioSeconds": round(chunk_duration_audio, 3),
        "RealTimeFactor": round(rtf, 3),
    }
    
    # Add GPU metrics if available
    if gpu_stats:
        metrics["GPUUtilizationPercent"] = gpu_stats['gpu_util_percent']
        metrics["GPUMemoryUtilizationPercent"] = gpu_stats['memory_util_percent']
        metrics["GPUMemoryUsedMB"] = gpu_stats['memory_used_mb']
    
    dimensions = {
        "ServiceType": "chunked" if total_chunks > 1 else "full-audio",
        "WorkerId": str(worker_id),
    }
    
    properties = {
        "chunk_index": chunk_index,
        "total_chunks": total_chunks,
        "model": model_name,
        "input_key": input_key,
    }
    
    emit_emf_metric("Parakeet/ASR", metrics, dimensions, properties)


def emit_request_metrics(worker_id: int, audio_duration: float, total_processing_time: float,
                         total_chunks: int, model_name: str, input_key: str,
                         download_time: float, prep_time: float, transcribe_time: float,
                         gpu_peak_gb: float = 0):
    """Emit metrics for a complete transcription request."""
    # Overall real-time factor for the entire request
    rtf = total_processing_time / audio_duration if audio_duration > 0 else 0
    
    # Throughput: audio seconds processed per wall-clock second
    throughput = audio_duration / total_processing_time if total_processing_time > 0 else 0
    
    metrics = {
        "RequestTotalSeconds": round(total_processing_time, 2),
        "AudioDurationSeconds": round(audio_duration, 2),
        "RequestRealTimeFactor": round(rtf, 3),
        "ThroughputAudioPerSecond": round(throughput, 2),
        "ChunkCount": total_chunks,
        "DownloadSeconds": round(download_time, 2),
        "PrepSeconds": round(prep_time, 2),
        "TranscribeSeconds": round(transcribe_time, 2),
    }
    
    if gpu_peak_gb > 0:
        metrics["GPUPeakMemoryGB"] = round(gpu_peak_gb, 2)
    
    dimensions = {
        "ServiceType": "chunked" if total_chunks > 1 else "full-audio",
        "Model": model_name.split('/')[-1],  # Just model name without org
    }
    
    properties = {
        "worker_id": worker_id,
        "input_key": input_key,
        "full_model_name": model_name,
    }
    
    emit_emf_metric("Parakeet/ASR", metrics, dimensions, properties)

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
    # Validate path to prevent command injection
    if not os.path.isfile(audio_path):
        raise ValueError(f"Invalid audio path: {audio_path}")
    # Use absolute path to avoid path traversal
    safe_path = os.path.abspath(audio_path)
    cmd = [
        'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', safe_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)  # nosec B603
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr}")
    return float(result.stdout.strip())


def split_audio(audio_path: str, chunk_duration: int) -> list:
    """Split audio into chunks."""
    # Validate path to prevent command injection
    if not os.path.isfile(audio_path):
        raise ValueError(f"Invalid audio path: {audio_path}")
    safe_path = os.path.abspath(audio_path)
    
    duration = get_audio_duration(safe_path)
    chunks = []
    base_name = os.path.splitext(os.path.basename(safe_path))[0]
    temp_dir = tempfile.mkdtemp()
    
    start_time = 0
    chunk_idx = 0
    
    while start_time < duration:
        chunk_path = os.path.join(temp_dir, f"{base_name}_chunk_{chunk_idx:04d}.wav")
        cmd = [
            'ffmpeg', '-y', '-i', safe_path,
            '-ss', str(start_time), '-t', str(chunk_duration),
            '-ar', '16000', '-ac', '1', chunk_path
        ]
        subprocess.run(cmd, capture_output=True, check=False)  # nosec B603
        
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
                   bucket: str, chunk_duration: int, max_duration: int, use_fp16: bool,
                   ready_event=None):
    """Worker process that loads its own model and processes requests."""
    import torch
    import gc
    import nemo.collections.asr as nemo_asr
    
    if torch.cuda.is_available():
        torch.cuda.set_device(0)
    
    print(f"[Worker {worker_id}] Starting, loading model: {model_name}...", flush=True)
    start = time.time()
    
    torch.cuda.empty_cache()
    gc.collect()  # Clean up before loading
    
    model = nemo_asr.models.ASRModel.from_pretrained(model_name)
    model.eval()
    
    if use_fp16 and torch.cuda.is_available():
        model = model.half()
    
    # Force garbage collection after model load to free temp memory
    gc.collect()
    torch.cuda.empty_cache()
    
    if torch.cuda.is_available():
        allocated = torch.cuda.memory_allocated() / 1e9
        total = torch.cuda.get_device_properties(0).total_memory / 1e9
        print(f"[Worker {worker_id}] Model loaded in {time.time() - start:.2f}s, GPU: {allocated:.2f}/{total:.2f}GB", flush=True)
    else:
        print(f"[Worker {worker_id}] Model loaded in {time.time() - start:.2f}s (CPU mode)", flush=True)
    
    s3_client = boto3.client('s3')
    
    # Signal that this worker is ready
    if ready_event is not None:
        ready_event.set()
    
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
    
    # Use secure temp file instead of predictable /tmp path
    file_ext = os.path.splitext(input_key)[1] or '.wav'
    temp_fd, local_audio = tempfile.mkstemp(suffix=file_ext, prefix=f'worker{worker_id}_')
    os.close(temp_fd)  # Close fd, we'll use the path with boto3
    
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
        chunk_audio_duration = chunk['end_time'] - chunk['start_time']
        transcriptions.append({
            'index': chunk['index'],
            'start_time': chunk['start_time'],
            'end_time': chunk['end_time'],
            'text': text,
            'processing_time': round(chunk_time, 2)
        })
        
        # Emit per-chunk EMF metrics
        emit_chunk_metrics(
            worker_id=worker_id,
            chunk_index=i,
            total_chunks=len(chunks),
            chunk_duration_audio=chunk_audio_duration,
            processing_time=chunk_time,
            model_name=model_name,
            input_key=input_key
        )
        
        del result
        
        if torch.cuda.is_available():
            gpu_gb = torch.cuda.memory_allocated() / 1e9
            print(f"[Worker {worker_id}]   Chunk {i+1}/{len(chunks)}: {chunk_time:.2f}s | GPU: {gpu_gb:.2f}GB", flush=True)
        
        os.remove(chunk['path'])
    
    transcribe_time = time.time() - transcribe_start
    full_text = ' '.join([t['text'] for t in transcriptions if t['text']])
    
    print(f"[Worker {worker_id}] Transcription completed in {transcribe_time:.2f}s", flush=True)
    
    memory = {}
    gpu_peak_gb = 0
    if torch.cuda.is_available():
        gpu_peak_gb = torch.cuda.max_memory_allocated() / 1e9
        memory = {
            'gpu_peak_gb': round(gpu_peak_gb, 2),
            'gpu_total_gb': round(torch.cuda.get_device_properties(0).total_memory / 1e9, 2),
        }
    
    # Emit request-level EMF metrics
    total_time = download_time + split_time + transcribe_time
    emit_request_metrics(
        worker_id=worker_id,
        audio_duration=total_duration,
        total_processing_time=total_time,
        total_chunks=len(chunks),
        model_name=model_name,
        input_key=input_key,
        download_time=download_time,
        prep_time=split_time,
        transcribe_time=transcribe_time,
        gpu_peak_gb=gpu_peak_gb
    )
    
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
    
    def __init__(self, request_queue, response_dict, workers):
        self.request_queue = request_queue
        self.response_dict = response_dict
        self.workers = workers  # List of worker processes for health check
        self.request_counter = 0
        self.counter_lock = threading.Lock()
    
    def _check_workers_alive(self) -> int:
        """Check how many workers are still alive."""
        alive_count = sum(1 for w in self.workers if w.is_alive())
        return alive_count
    
    def Transcribe(self, request, context):
        """Handle transcription request by dispatching to worker pool."""
        input_key = request.input_key
        
        if not input_key:
            return transcribe_pb2.TranscribeResponse(error="input_key required")
        
        # Check worker health before accepting request
        alive_workers = self._check_workers_alive()
        if alive_workers == 0:
            print(f"[gRPC] ERROR: All workers are dead!", flush=True)
            return transcribe_pb2.TranscribeResponse(error="No workers available - all workers have died")
        
        with self.counter_lock:
            self.request_counter += 1
            request_id = self.request_counter
        
        print(f"[gRPC] Request #{request_id} received: {input_key} (workers alive: {alive_workers}/{len(self.workers)})", flush=True)
        
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
    worker_batch_size = int(os.environ.get('WORKER_BATCH_SIZE', '2'))  # Load 2 workers at a time
    
    print(f"=== Parakeet ASR Server (Process Pool) ===", flush=True)
    print(f"Model: {model_name}", flush=True)
    print(f"Workers: {NUM_WORKERS}", flush=True)
    print(f"Worker batch size: {worker_batch_size}", flush=True)
    print(f"Chunk duration: {CHUNK_DURATION}s", flush=True)
    print(f"Max audio: {MAX_AUDIO_DURATION_MINUTES} min", flush=True)
    print(f"FP16: {use_fp16}", flush=True)
    print(f"==========================================", flush=True)
    
    # Use Manager for both queue and dict - more robust for long-running processes
    # mp.Queue can have issues after extended idle periods
    manager = get_manager()
    request_queue = manager.Queue()
    response_dict = manager.dict()
    
    # Start worker processes in batches to avoid RAM spike
    workers = []
    for batch_start in range(0, NUM_WORKERS, worker_batch_size):
        batch_end = min(batch_start + worker_batch_size, NUM_WORKERS)
        batch_workers = []
        ready_events = []
        
        print(f"Starting worker batch {batch_start}-{batch_end-1}...", flush=True)
        
        for i in range(batch_start, batch_end):
            ready_event = mp.Event()
            ready_events.append(ready_event)
            
            p = mp.Process(
                target=worker_process,
                args=(i, request_queue, response_dict, model_name, bucket, 
                      CHUNK_DURATION, MAX_AUDIO_DURATION_SECONDS, use_fp16, ready_event),
            )
            p.start()
            batch_workers.append(p)
            workers.append(p)
            print(f"Started worker {i} (PID: {p.pid})", flush=True)
        
        # Wait for all workers in this batch to signal ready (model loaded)
        print(f"Waiting for batch {batch_start}-{batch_end-1} to load models...", flush=True)
        for idx, event in enumerate(ready_events):
            worker_id = batch_start + idx
            if event.wait(timeout=300):  # 5 min timeout per batch
                print(f"Worker {worker_id} ready", flush=True)
            else:
                print(f"WARNING: Worker {worker_id} did not signal ready in time", flush=True)
        
        # Small delay between batches to let memory settle
        if batch_end < NUM_WORKERS:
            print(f"Batch {batch_start}-{batch_end-1} loaded. Pausing before next batch...", flush=True)
            time.sleep(3)
    
    # Start gRPC server
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    transcribe_pb2_grpc.add_TranscribeServiceServicer_to_server(
        TranscribeServicer(request_queue, response_dict, workers), server
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
