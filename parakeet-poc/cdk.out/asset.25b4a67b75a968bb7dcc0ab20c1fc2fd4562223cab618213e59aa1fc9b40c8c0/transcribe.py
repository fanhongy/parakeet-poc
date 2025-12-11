#!/usr/bin/env python3
"""
Parakeet transcription server for ECS.
Runs as HTTP server, receives S3 keys, transcribes in 30s chunks, uploads results.
Model stays loaded in memory for fast processing.
"""
import os
import json
import time
import boto3
import tempfile
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler
import nemo.collections.asr as nemo_asr

# Global model - loaded once at startup
MODEL = None
MODEL_NAME = None
S3_CLIENT = boto3.client('s3')
BUCKET = os.environ['S3_BUCKET']
CHUNK_DURATION = 30  # seconds per chunk

def load_model():
    global MODEL, MODEL_NAME
    MODEL_NAME = os.environ.get('PARAKEET_MODEL', 'nvidia/parakeet-rnnt-1.1b')
    print(f"Loading model: {MODEL_NAME}...", flush=True)
    start = time.time()
    MODEL = nemo_asr.models.ASRModel.from_pretrained(MODEL_NAME)
    print(f"Model loaded in {time.time() - start:.2f}s", flush=True)

def get_audio_duration(audio_path: str) -> float:
    """Get audio duration in seconds using ffprobe."""
    cmd = [
        'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', audio_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return float(result.stdout.strip())

def split_audio(audio_path: str, chunk_duration: int = CHUNK_DURATION) -> list:
    """Split audio into chunks and return list of chunk file paths."""
    duration = get_audio_duration(audio_path)
    chunks = []
    
    base_name = os.path.splitext(os.path.basename(audio_path))[0]
    temp_dir = tempfile.mkdtemp()
    
    start_time = 0
    chunk_idx = 0
    
    while start_time < duration:
        chunk_path = os.path.join(temp_dir, f"{base_name}_chunk_{chunk_idx:04d}.wav")
        
        # Use ffmpeg to extract chunk and convert to wav
        cmd = [
            'ffmpeg', '-y', '-i', audio_path,
            '-ss', str(start_time),
            '-t', str(chunk_duration),
            '-ar', '16000',  # 16kHz sample rate for ASR
            '-ac', '1',      # mono
            chunk_path
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

def transcribe(input_key: str) -> dict:
    """Download audio, split into chunks, transcribe each, combine results."""
    base_name = os.path.splitext(os.path.basename(input_key))[0]
    output_key = f"output/{base_name}_transcript.json"
    local_audio = f"/tmp/{os.path.basename(input_key)}"
    
    print(f"Processing: s3://{BUCKET}/{input_key}", flush=True)
    
    # Download
    download_start = time.time()
    S3_CLIENT.download_file(BUCKET, input_key, local_audio)
    download_time = time.time() - download_start
    print(f"Downloaded in {download_time:.2f}s", flush=True)
    
    # Get total duration
    total_duration = get_audio_duration(local_audio)
    print(f"Audio duration: {total_duration:.1f}s ({total_duration/60:.1f} min)", flush=True)
    
    # Split into chunks
    split_start = time.time()
    chunks = split_audio(local_audio)
    split_time = time.time() - split_start
    print(f"Split completed in {split_time:.2f}s", flush=True)
    
    # Transcribe each chunk
    transcribe_start = time.time()
    transcriptions = []
    
    for i, chunk in enumerate(chunks):
        chunk_start = time.time()
        result = MODEL.transcribe([chunk['path']])
        chunk_time = time.time() - chunk_start
        
        text = result[0] if result else ''
        transcriptions.append({
            'index': chunk['index'],
            'start_time': chunk['start_time'],
            'end_time': chunk['end_time'],
            'text': text,
            'processing_time': round(chunk_time, 2)
        })
        
        print(f"  Chunk {i+1}/{len(chunks)}: {chunk_time:.2f}s", flush=True)
        
        # Cleanup chunk file
        os.remove(chunk['path'])
    
    transcribe_time = time.time() - transcribe_start
    print(f"Transcription completed in {transcribe_time:.2f}s", flush=True)
    
    # Combine all transcriptions into full text
    full_text = ' '.join([t['text'] for t in transcriptions if t['text']])
    
    result = {
        'input_file': input_key,
        'model': MODEL_NAME,
        'transcription': full_text,
        'segments': transcriptions,
        'audio_duration_seconds': round(total_duration, 2),
        'timing': {
            'download_seconds': round(download_time, 2),
            'split_seconds': round(split_time, 2),
            'transcription_seconds': round(transcribe_time, 2),
            'total_seconds': round(download_time + split_time + transcribe_time, 2),
        },
        'chunk_config': {
            'chunk_duration_seconds': CHUNK_DURATION,
            'total_chunks': len(chunks)
        }
    }
    
    # Upload result
    S3_CLIENT.put_object(
        Bucket=BUCKET,
        Key=output_key,
        Body=json.dumps(result, indent=2),
        ContentType='application/json'
    )
    print(f"Result saved to s3://{BUCKET}/{output_key}", flush=True)
    
    # Cleanup
    os.remove(local_audio)
    return result

class TranscribeHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        if '/health' not in args[0]:
            print(f"{self.address_string()} - {format % args}", flush=True)
    
    def do_POST(self):
        if self.path == '/transcribe':
            content_length = int(self.headers['Content-Length'])
            body = json.loads(self.rfile.read(content_length))
            input_key = body.get('input_key')
            
            if not input_key:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "input_key required"}')
                return
            
            try:
                result = transcribe(input_key)
                timing = result['timing']
                print(f"=== TRANSCRIPTION COMPLETE ===", flush=True)
                print(f"  File: {input_key}", flush=True)
                print(f"  Audio duration: {result['audio_duration_seconds']}s", flush=True)
                print(f"  Chunks: {result['chunk_config']['total_chunks']}", flush=True)
                print(f"  Download: {timing['download_seconds']}s", flush=True)
                print(f"  Split: {timing['split_seconds']}s", flush=True)
                print(f"  Transcription: {timing['transcription_seconds']}s", flush=True)
                print(f"  Total: {timing['total_seconds']}s", flush=True)
                print(f"==============================", flush=True)
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())
            except Exception as e:
                print(f"ERROR: {str(e)}", flush=True)
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode())
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status": "healthy", "model_loaded": true}')
        else:
            self.send_response(404)
            self.end_headers()

def main():
    load_model()
    port = int(os.environ.get('PORT', 8080))
    server = HTTPServer(('0.0.0.0', port), TranscribeHandler)
    print(f"Server running on port {port}", flush=True)
    server.serve_forever()

if __name__ == '__main__':
    main()
