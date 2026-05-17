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
import soundfile as sf
from pydub import AudioSegment
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

# TensorRT configuration
USE_TENSORRT = os.environ.get('USE_TENSORRT', 'false').lower() == 'true'
TENSORRT_ENGINE_PATH = os.environ.get('TENSORRT_ENGINE_PATH', '/app/trt_model/model.engine')
TENSORRT_METADATA_PATH = os.environ.get('TENSORRT_METADATA_PATH', '/app/trt_model/metadata.json')


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
    """Get audio duration in seconds using soundfile."""
    if not os.path.isfile(audio_path):
        raise ValueError(f"Invalid audio path: {audio_path}")
    safe_path = os.path.abspath(audio_path)
    info = sf.info(safe_path)
    return info.duration


def split_audio(audio_path: str, chunk_duration: int) -> list:
    """Split audio into chunks using pydub."""
    if not os.path.isfile(audio_path):
        raise ValueError(f"Invalid audio path: {audio_path}")
    safe_path = os.path.abspath(audio_path)

    duration = get_audio_duration(safe_path)
    audio = AudioSegment.from_file(safe_path).set_frame_rate(16000).set_channels(1)
    chunks = []
    base_name = os.path.splitext(os.path.basename(safe_path))[0]
    temp_dir = tempfile.mkdtemp()
    chunk_ms = chunk_duration * 1000

    chunk_idx = 0
    start_ms = 0
    total_ms = len(audio)

    while start_ms < total_ms:
        end_ms = min(start_ms + chunk_ms, total_ms)
        chunk_path = os.path.join(temp_dir, f"{base_name}_chunk_{chunk_idx:04d}.wav")
        audio[start_ms:end_ms].export(chunk_path, format="wav")

        if os.path.exists(chunk_path) and os.path.getsize(chunk_path) > 0:
            chunks.append({
                'path': chunk_path,
                'start_time': start_ms / 1000.0,
                'end_time': end_ms / 1000.0,
                'index': chunk_idx
            })

        start_ms = end_ms
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


# =============================================================================
# TensorRT Worker Process
# =============================================================================

def compute_mel_spectrogram(audio_path, sample_rate=16000, n_fft=512,
                            hop_length=160, win_length=320, n_mels=80):
    """Compute log-mel spectrogram features from audio file.

    This is a NumPy reimplementation of the mel feature extraction for use in
    the TensorRT inference path (avoids loading NeMo/PyTorch at runtime).

    NOTE: This implementation differs from NeMo's AudioToMelSpectrogramPreprocessor
    in several ways that may cause minor WER degradation:
      - No dither noise is added before STFT (NeMo adds small random noise to
        prevent log(0); here we use a 1e-9 floor instead).
      - Padding uses np.pad with 'reflect' mode which approximates but does not
        exactly match torch.stft center=True behavior (potential off-by-one at
        signal boundaries).
      - Per-utterance normalization (zero mean, unit variance) is applied per
        feature dimension. NeMo's behavior depends on model config -- some models
        use global stats or per-batch normalization.
      - Resampling (when input is not 16kHz) uses scipy.signal.resample which
        applies a proper anti-aliasing filter in the frequency domain. This is
        a reasonable approximation but not identical to NeMo's internal resampling.
    If transcription accuracy is critical, validate outputs against NeMo's
    preprocessor on representative audio samples before deploying this path.

    Replicates the NeMo preprocessor behavior:
      - Load audio at 16kHz mono
      - STFT with 512 FFT, 160 hop (10ms), 320 window (20ms)
      - Apply 80-mel filterbank
      - Log mel: log(mel + 1e-9)
      - Normalize per-feature (zero mean, unit variance)

    Returns:
        features: numpy array of shape (n_mels, time_frames)
        length: number of time frames
    """
    import numpy as np

    # Load audio
    data, sr = sf.read(audio_path, dtype='float32')
    if len(data.shape) > 1:
        data = data.mean(axis=1)  # mono
    if sr != sample_rate:
        # Resample using scipy.signal.resample which applies a proper
        # anti-aliasing filter (frequency-domain method) to avoid aliasing
        # artifacts that linear interpolation would introduce.
        import warnings
        try:
            from scipy.signal import resample as scipy_resample
            target_len = int(len(data) * sample_rate / sr)
            data = scipy_resample(data, target_len).astype(np.float32)
        except ImportError:
            warnings.warn(
                "scipy not available; falling back to linear interpolation for "
                "resampling. This may introduce aliasing artifacts and degrade "
                "transcription quality for non-16kHz audio.",
                RuntimeWarning,
                stacklevel=2,
            )
            duration = len(data) / sr
            target_len = int(duration * sample_rate)
            indices = np.linspace(0, len(data) - 1, target_len)
            data = np.interp(indices, np.arange(len(data)), data).astype(np.float32)

    # STFT
    # Pad signal
    pad_length = n_fft // 2
    data = np.pad(data, (pad_length, pad_length), mode='reflect')

    # Frame the signal
    num_frames = 1 + (len(data) - n_fft) // hop_length
    frames = np.lib.stride_tricks.as_strided(
        data,
        shape=(num_frames, n_fft),
        strides=(data.strides[0] * hop_length, data.strides[0]),
    )

    # Apply Hann window
    window = np.hanning(n_fft + 1)[:-1].astype(np.float32)
    frames = frames * window

    # FFT
    spectrum = np.fft.rfft(frames, n=n_fft)
    power_spectrum = np.abs(spectrum) ** 2

    # Mel filterbank
    mel_basis = _create_mel_filterbank(sample_rate, n_fft, n_mels)
    mel_spec = np.dot(power_spectrum, mel_basis.T)

    # Log mel
    mel_spec = np.log(mel_spec + 1e-9)

    # Normalize per-feature (zero mean, unit variance)
    mean = mel_spec.mean(axis=0, keepdims=True)
    std = mel_spec.std(axis=0, keepdims=True)
    std = np.maximum(std, 1e-5)
    mel_spec = (mel_spec - mean) / std

    # Transpose to (n_mels, time)
    features = mel_spec.T.astype(np.float32)
    return features, features.shape[1]


def _create_mel_filterbank(sample_rate, n_fft, n_mels, fmin=0.0, fmax=None):
    """Create mel filterbank matrix."""
    import numpy as np

    if fmax is None:
        fmax = sample_rate / 2.0

    def hz_to_mel(hz):
        return 2595.0 * np.log10(1.0 + hz / 700.0)

    def mel_to_hz(mel):
        return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)

    mel_min = hz_to_mel(fmin)
    mel_max = hz_to_mel(fmax)
    mel_points = np.linspace(mel_min, mel_max, n_mels + 2)
    hz_points = mel_to_hz(mel_points)

    bin_points = np.floor((n_fft + 1) * hz_points / sample_rate).astype(int)
    n_freqs = n_fft // 2 + 1
    filterbank = np.zeros((n_mels, n_freqs), dtype=np.float32)

    for i in range(n_mels):
        left = bin_points[i]
        center = bin_points[i + 1]
        right = bin_points[i + 2]

        for j in range(left, center):
            if center != left:
                filterbank[i, j] = (j - left) / (center - left)
        for j in range(center, right):
            if right != center:
                filterbank[i, j] = (right - j) / (right - center)

    return filterbank


def ctc_greedy_decode(logits, vocabulary, blank_id=0):
    """CTC greedy decoding: argmax, remove consecutive duplicates, remove blanks.

    Args:
        logits: numpy array of shape (time, vocab_size)
        vocabulary: list of token strings (does not include blank)
        blank_id: index of blank token (default 0)

    Returns:
        decoded text string
    """
    import numpy as np

    # Argmax over vocabulary dimension
    token_ids = np.argmax(logits, axis=-1)

    # Remove consecutive duplicates
    deduplicated = []
    prev = -1
    for tid in token_ids:
        if tid != prev:
            deduplicated.append(int(tid))
        prev = tid

    # Remove blank tokens and map to characters
    tokens = []
    for tid in deduplicated:
        if tid == blank_id:
            continue
        # vocabulary index is offset by 1 (blank is 0, first vocab token is 1)
        vocab_idx = tid - 1
        if 0 <= vocab_idx < len(vocabulary):
            tokens.append(vocabulary[vocab_idx])

    # Join tokens - handle SentencePiece style (tokens starting with special char)
    text = "".join(tokens)
    # SentencePiece uses the Unicode character \u2581 as word separator
    text = text.replace("\u2581", " ").strip()
    return text


def trt_worker_process(worker_id, request_queue, response_dict, model_name,
                       bucket, chunk_duration, max_duration, use_fp16,
                       ready_event=None):
    """TensorRT-based worker process.

    Loads a pre-compiled TensorRT engine and runs inference without NeMo.
    Falls back to PyTorch worker if the engine file is not found.
    """
    import numpy as np

    engine_path = TENSORRT_ENGINE_PATH
    metadata_path = TENSORRT_METADATA_PATH

    # Check if engine exists, fall back to PyTorch if not
    if not os.path.isfile(engine_path):
        print(
            f"[Worker {worker_id}] WARNING: TensorRT engine not found at {engine_path}. "
            f"Falling back to PyTorch inference.",
            flush=True,
        )
        worker_process(
            worker_id, request_queue, response_dict, model_name,
            bucket, chunk_duration, max_duration, use_fp16, ready_event
        )
        return

    # Load metadata
    if not os.path.isfile(metadata_path):
        print(
            f"[Worker {worker_id}] WARNING: TensorRT metadata not found at {metadata_path}. "
            f"Falling back to PyTorch inference.",
            flush=True,
        )
        worker_process(
            worker_id, request_queue, response_dict, model_name,
            bucket, chunk_duration, max_duration, use_fp16, ready_event
        )
        return

    with open(metadata_path, "r") as f:
        metadata = json.load(f)

    vocabulary = metadata["vocabulary"]
    blank_id = metadata.get("blank_id", 0)
    n_mels = metadata.get("n_mels", 80)
    hop_length = metadata.get("hop_length", 160)
    win_length = metadata.get("win_length", 320)
    n_fft = metadata.get("n_fft", 512)
    sample_rate = metadata.get("sample_rate", 16000)
    encoder_dim = metadata.get("encoder_dim", 512)

    # Determine engine paths
    engine_files = metadata.get("engine_files", {})
    engine_dir = os.path.dirname(engine_path)
    encoder_engine_path = os.path.join(
        engine_dir, engine_files.get("encoder", "model_encoder.engine")
    )
    decoder_engine_path = os.path.join(
        engine_dir, engine_files.get("decoder", "model_decoder.engine")
    )

    # Verify both encoder and decoder engines exist. A partial build (e.g.,
    # encoder present but decoder missing) would silently produce incorrect
    # output if we proceeded. Fall back to PyTorch in that case.
    if not os.path.isfile(encoder_engine_path):
        print(
            f"[Worker {worker_id}] WARNING: Encoder engine not found at "
            f"{encoder_engine_path}. Falling back to PyTorch inference.",
            flush=True,
        )
        worker_process(
            worker_id, request_queue, response_dict, model_name,
            bucket, chunk_duration, max_duration, use_fp16, ready_event
        )
        return

    if not os.path.isfile(decoder_engine_path):
        print(
            f"[Worker {worker_id}] WARNING: Decoder engine not found at "
            f"{decoder_engine_path}. Partial TRT build detected (encoder present, "
            f"decoder missing). Falling back to PyTorch inference.",
            flush=True,
        )
        worker_process(
            worker_id, request_queue, response_dict, model_name,
            bucket, chunk_duration, max_duration, use_fp16, ready_event
        )
        return

    print(f"[Worker {worker_id}] Loading TensorRT engine(s)...", flush=True)
    start = time.time()

    import tensorrt as trt
    import pycuda.driver as cuda
    import pycuda.autoinit  # noqa: F401 - initializes CUDA context

    TRT_LOGGER = trt.Logger(trt.Logger.WARNING)
    runtime = trt.Runtime(TRT_LOGGER)

    # Load encoder engine
    with open(encoder_engine_path, "rb") as f:
        encoder_engine = runtime.deserialize_cuda_engine(f.read())
    encoder_context = encoder_engine.create_execution_context()

    # Load decoder engine
    with open(decoder_engine_path, "rb") as f:
        decoder_engine = runtime.deserialize_cuda_engine(f.read())
    decoder_context = decoder_engine.create_execution_context()

    elapsed = time.time() - start
    print(
        f"[Worker {worker_id}] TensorRT engine(s) loaded in {elapsed:.2f}s",
        flush=True,
    )

    s3_client = boto3.client("s3")

    # Signal ready
    if ready_event is not None:
        ready_event.set()

    print(f"[Worker {worker_id}] Ready for requests (TensorRT mode)", flush=True)

    while True:
        try:
            request = request_queue.get()

            if request is None:
                print(f"[Worker {worker_id}] Shutting down", flush=True)
                break

            request_id = request["request_id"]
            input_key = request["input_key"]

            print(
                f"[Worker {worker_id}] Processing request #{request_id}: {input_key}",
                flush=True,
            )

            try:
                result = process_transcription_trt(
                    worker_id=worker_id,
                    encoder_engine=encoder_engine,
                    encoder_context=encoder_context,
                    decoder_engine=decoder_engine,
                    decoder_context=decoder_context,
                    s3_client=s3_client,
                    bucket=bucket,
                    input_key=input_key,
                    chunk_duration=chunk_duration,
                    max_duration=max_duration,
                    model_name=model_name,
                    vocabulary=vocabulary,
                    blank_id=blank_id,
                    n_mels=n_mels,
                    hop_length=hop_length,
                    win_length=win_length,
                    n_fft=n_fft,
                    sample_rate=sample_rate,
                    encoder_dim=encoder_dim,
                    vocab_size=metadata.get("vocab_size"),
                )
                response_dict[request_id] = {"result": result, "error": None, "done": True}

            except Exception as e:
                import traceback

                print(
                    f"[Worker {worker_id}] Error processing #{request_id}: {e}",
                    flush=True,
                )
                traceback.print_exc()
                response_dict[request_id] = {"result": None, "error": str(e), "done": True}

        except Exception as e:
            print(f"[Worker {worker_id}] Queue error: {e}", flush=True)


def process_transcription_trt(worker_id, encoder_engine, encoder_context,
                              decoder_engine, decoder_context, s3_client,
                              bucket, input_key, chunk_duration, max_duration,
                              model_name, vocabulary, blank_id, n_mels,
                              hop_length, win_length, n_fft, sample_rate,
                              encoder_dim, vocab_size=None):
    """Process a single transcription request using TensorRT."""
    import numpy as np
    import pycuda.driver as cuda

    base_name = os.path.splitext(os.path.basename(input_key))[0]
    output_key = f"output/{base_name}_transcript.json"

    # Download audio
    file_ext = os.path.splitext(input_key)[1] or ".wav"
    temp_fd, local_audio = tempfile.mkstemp(suffix=file_ext, prefix=f"worker{worker_id}_")
    os.close(temp_fd)

    download_start = time.time()
    s3_client.download_file(bucket, input_key, local_audio)
    download_time = time.time() - download_start
    print(f"[Worker {worker_id}] Downloaded in {download_time:.2f}s", flush=True)

    total_duration = get_audio_duration(local_audio)
    print(f"[Worker {worker_id}] Audio duration: {total_duration:.1f}s", flush=True)

    if total_duration > max_duration:
        os.remove(local_audio)
        raise ValueError(
            f"Audio too long: {total_duration / 60:.1f} min > {max_duration / 60:.0f} min max"
        )

    split_start = time.time()
    chunks = split_audio(local_audio, chunk_duration)
    split_time = time.time() - split_start
    print(f"[Worker {worker_id}] Split into {len(chunks)} chunks in {split_time:.2f}s", flush=True)

    transcribe_start = time.time()
    transcriptions = []

    for i, chunk in enumerate(chunks):
        chunk_start = time.time()

        # Compute mel spectrogram
        features, seq_len = compute_mel_spectrogram(
            chunk["path"],
            sample_rate=sample_rate,
            n_fft=n_fft,
            hop_length=hop_length,
            win_length=win_length,
            n_mels=n_mels,
        )

        # Run TRT inference
        logits = _run_trt_inference(
            encoder_engine, encoder_context,
            decoder_engine, decoder_context,
            features, seq_len, encoder_dim,
            vocab_size=vocab_size,
        )

        # CTC decode
        text = ctc_greedy_decode(logits, vocabulary, blank_id)

        chunk_time = time.time() - chunk_start
        chunk_audio_duration = chunk["end_time"] - chunk["start_time"]

        transcriptions.append({
            "index": chunk["index"],
            "start_time": chunk["start_time"],
            "end_time": chunk["end_time"],
            "text": text,
            "processing_time": round(chunk_time, 2),
        })

        # Emit per-chunk metrics
        emit_chunk_metrics(
            worker_id=worker_id,
            chunk_index=i,
            total_chunks=len(chunks),
            chunk_duration_audio=chunk_audio_duration,
            processing_time=chunk_time,
            model_name=model_name,
            input_key=input_key,
        )

        print(
            f"[Worker {worker_id}]   Chunk {i + 1}/{len(chunks)}: {chunk_time:.2f}s (TRT)",
            flush=True,
        )
        os.remove(chunk["path"])

    transcribe_time = time.time() - transcribe_start
    full_text = " ".join([t["text"] for t in transcriptions if t["text"]])

    print(f"[Worker {worker_id}] Transcription completed in {transcribe_time:.2f}s (TRT)", flush=True)

    # Collect GPU memory metrics for capacity planning
    gpu_peak_gb = 0
    memory = {}
    try:
        import pycuda.driver as cuda
        # Query GPU memory via nvidia-smi for accurate reporting
        gpu_stats = get_gpu_utilization()
        if gpu_stats:
            gpu_peak_gb = gpu_stats.get('memory_used_mb', 0) / 1024.0
            memory = {
                'gpu_peak_gb': round(gpu_peak_gb, 2),
                'gpu_total_gb': round(gpu_stats.get('memory_total_mb', 0) / 1024.0, 2),
            }
    except Exception:
        pass

    # Emit request-level metrics
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
        gpu_peak_gb=gpu_peak_gb,
    )

    result = {
        "input_file": input_key,
        "model": model_name,
        "transcription": full_text,
        "segments": transcriptions,
        "audio_duration_seconds": round(total_duration, 2),
        "timing": {
            "download_seconds": round(download_time, 2),
            "prep_seconds": round(split_time, 2),
            "transcription_seconds": round(transcribe_time, 2),
            "total_seconds": round(total_time, 2),
        },
        "processing_config": {
            "chunking_enabled": True,
            "chunk_duration_seconds": chunk_duration,
            "total_chunks": len(chunks),
        },
        "memory": memory,
        "worker_id": worker_id,
        "inference_backend": "tensorrt",
    }

    s3_client.put_object(
        Bucket=bucket,
        Key=output_key,
        Body=json.dumps(result, indent=2),
        ContentType="application/json",
    )
    print(f"[Worker {worker_id}] Result saved to s3://{bucket}/{output_key}", flush=True)

    os.remove(local_audio)
    return result


def _run_trt_inference(encoder_engine, encoder_context, decoder_engine,
                       decoder_context, features, seq_len, encoder_dim,
                       vocab_size=None):
    """Run TensorRT inference on mel features and return logits.

    Args:
        encoder_engine: TensorRT encoder engine
        encoder_context: TensorRT encoder execution context
        decoder_engine: TensorRT decoder engine (may be None)
        decoder_context: TensorRT decoder execution context (may be None)
        features: numpy array (n_mels, time)
        seq_len: number of time frames
        encoder_dim: encoder output dimension
        vocab_size: vocabulary size (including blank token) from metadata,
                    used to determine logits orientation deterministically

    Returns:
        logits: numpy array (time, vocab_size)
    """
    import numpy as np
    import pycuda.driver as cuda
    import tensorrt as trt

    # Prepare encoder input: (1, n_mels, time)
    audio_signal = features[np.newaxis, :, :].astype(np.float32)
    length_input = np.array([seq_len], dtype=np.int64)

    batch_size = 1
    n_mels_dim = audio_signal.shape[1]
    time_dim = audio_signal.shape[2]

    # Set encoder input shapes
    encoder_context.set_input_shape("audio_signal", (batch_size, n_mels_dim, time_dim))
    encoder_context.set_input_shape("length", (batch_size,))

    # Allocate device memory for encoder
    d_audio = cuda.mem_alloc(audio_signal.nbytes)
    d_length = cuda.mem_alloc(length_input.nbytes)

    # Get encoder output shape
    # Encoder output is typically (batch, time_encoded, encoder_dim) or (batch, encoder_dim, time_encoded)
    # We need to query the engine for output shape after setting input shapes
    encoded_shape = encoder_context.get_tensor_shape("encoded")
    encoded_len_shape = encoder_context.get_tensor_shape("encoded_len")

    encoded_output = np.empty(encoded_shape, dtype=np.float32)
    encoded_len_output = np.empty(encoded_len_shape, dtype=np.int64)

    d_encoded = cuda.mem_alloc(encoded_output.nbytes)
    d_encoded_len = cuda.mem_alloc(encoded_len_output.nbytes)

    # Copy inputs to device
    cuda.memcpy_htod(d_audio, audio_signal)
    cuda.memcpy_htod(d_length, length_input)

    # Set tensor addresses
    encoder_context.set_tensor_address("audio_signal", int(d_audio))
    encoder_context.set_tensor_address("length", int(d_length))
    encoder_context.set_tensor_address("encoded", int(d_encoded))
    encoder_context.set_tensor_address("encoded_len", int(d_encoded_len))

    # Execute encoder
    encoder_context.execute_async_v3(stream_handle=0)
    cuda.Context.synchronize()

    # Copy encoder output back
    cuda.memcpy_dtoh(encoded_output, d_encoded)
    cuda.memcpy_dtoh(encoded_len_output, d_encoded_len)

    # Free encoder input memory
    d_audio.free()
    d_length.free()

    # Run decoder if separate engine exists
    if decoder_engine is not None and decoder_context is not None:
        # Decoder input: (batch, encoder_dim, time_encoded)
        # The encoder output may be (batch, time, dim) - need to transpose
        if encoded_output.ndim == 3 and encoded_output.shape[2] == encoder_dim:
            # (batch, time, dim) -> (batch, dim, time)
            decoder_input = np.ascontiguousarray(encoded_output.transpose(0, 2, 1))
        else:
            decoder_input = np.ascontiguousarray(encoded_output)

        dec_time = decoder_input.shape[2] if decoder_input.ndim == 3 else decoder_input.shape[1]

        decoder_context.set_input_shape(
            "encoder_output",
            (batch_size, encoder_dim, dec_time),
        )

        d_dec_input = cuda.mem_alloc(decoder_input.nbytes)
        cuda.memcpy_htod(d_dec_input, decoder_input)

        # Get decoder output shape
        logits_shape = decoder_context.get_tensor_shape("logits")
        logits_output = np.empty(logits_shape, dtype=np.float32)
        d_logits = cuda.mem_alloc(logits_output.nbytes)

        decoder_context.set_tensor_address("encoder_output", int(d_dec_input))
        decoder_context.set_tensor_address("logits", int(d_logits))

        decoder_context.execute_async_v3(stream_handle=0)
        cuda.Context.synchronize()

        cuda.memcpy_dtoh(logits_output, d_logits)

        d_dec_input.free()
        d_logits.free()
        d_encoded.free()
        d_encoded_len.free()

        # logits_output shape: (batch, time, vocab) or (batch, vocab, time)
        logits = logits_output[0]  # Remove batch dim
        # Determine orientation using vocab_size from metadata when available
        # This avoids the fragile heuristic of comparing dimensions by size,
        # which fails when time steps < vocab_size (short audio clips < ~10s).
        if logits.ndim == 2 and vocab_size is not None:
            if logits.shape[0] == vocab_size and logits.shape[1] != vocab_size:
                logits = logits.T
        elif logits.ndim == 2 and logits.shape[0] < logits.shape[1]:
            # Fallback heuristic if vocab_size not provided
            logits = logits.T
    else:
        # Single engine case - encoded_output contains final logits
        d_encoded.free()
        d_encoded_len.free()
        logits = encoded_output[0]
        # Determine orientation using vocab_size from metadata when available
        if logits.ndim == 2 and vocab_size is not None:
            if logits.shape[0] == vocab_size and logits.shape[1] != vocab_size:
                logits = logits.T
        elif logits.ndim == 2 and logits.shape[0] < logits.shape[1]:
            # Fallback heuristic if vocab_size not provided
            logits = logits.T

    return logits


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
        self.pending_events = {}  # request_id -> threading.Event
    
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
        
        # Create event for this request
        done_event = threading.Event()
        with self.counter_lock:
            self.pending_events[request_id] = done_event
        
        # Start monitor thread to watch for response
        def _watch():
            while not done_event.is_set():
                if self.response_dict.get(request_id, {}).get('done'):
                    done_event.set()
                    return
                done_event.wait(0.1)
        watcher = threading.Thread(target=_watch, daemon=True)
        watcher.start()
        
        # Submit to worker pool
        self.request_queue.put({
            'request_id': request_id,
            'input_key': input_key,
        })
        
        # Wait for response via event
        done_event.wait(timeout=600)
        
        response = self.response_dict.get(request_id, {})
        
        # Cleanup
        with self.counter_lock:
            self.pending_events.pop(request_id, None)
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
    
    # Select worker function based on TensorRT mode
    if USE_TENSORRT:
        target_worker = trt_worker_process
        inference_mode = "TensorRT"
    else:
        target_worker = worker_process
        inference_mode = "PyTorch"
    
    print(f"=== Parakeet ASR Server (Process Pool) ===", flush=True)
    print(f"Model: {model_name}", flush=True)
    print(f"Inference: {inference_mode}", flush=True)
    if USE_TENSORRT:
        print(f"TRT engine: {TENSORRT_ENGINE_PATH}", flush=True)
        print(f"TRT metadata: {TENSORRT_METADATA_PATH}", flush=True)
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
                target=target_worker,
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
            settle_event = mp.Event()
            settle_event.wait(timeout=3)
    
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
