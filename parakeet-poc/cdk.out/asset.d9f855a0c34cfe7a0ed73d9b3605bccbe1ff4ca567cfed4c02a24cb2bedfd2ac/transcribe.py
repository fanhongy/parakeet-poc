#!/usr/bin/env python3
"""
Parakeet transcription server for ECS.
Runs as HTTP server, receives S3 keys, transcribes, uploads results.
Model stays loaded in memory for fast processing.
"""
import os
import json
import time
import boto3
from http.server import HTTPServer, BaseHTTPRequestHandler
import nemo.collections.asr as nemo_asr

# Global model - loaded once at startup
MODEL = None
MODEL_NAME = None
S3_CLIENT = boto3.client('s3')
BUCKET = os.environ['S3_BUCKET']

def load_model():
    global MODEL, MODEL_NAME
    MODEL_NAME = os.environ.get('PARAKEET_MODEL', 'nvidia/parakeet-rnnt-1.1b')
    print(f"Loading model: {MODEL_NAME}...")
    start = time.time()
    MODEL = nemo_asr.models.ASRModel.from_pretrained(MODEL_NAME)
    print(f"Model loaded in {time.time() - start:.2f}s")

def transcribe(input_key: str) -> dict:
    """Download audio, transcribe, upload result."""
    base_name = os.path.splitext(os.path.basename(input_key))[0]
    output_key = f"output/{base_name}_transcript.json"
    local_audio = f"/tmp/{os.path.basename(input_key)}"
    
    print(f"Processing: s3://{BUCKET}/{input_key}")
    
    # Download
    download_start = time.time()
    S3_CLIENT.download_file(BUCKET, input_key, local_audio)
    download_time = time.time() - download_start
    print(f"Downloaded in {download_time:.2f}s")
    
    # Transcribe
    transcribe_start = time.time()
    transcriptions = MODEL.transcribe([local_audio])
    transcribe_time = time.time() - transcribe_start
    print(f"Transcribed in {transcribe_time:.2f}s")
    
    result = {
        'input_file': input_key,
        'model': MODEL_NAME,
        'transcription': transcriptions[0] if transcriptions else '',
        'timing': {
            'download_seconds': round(download_time, 2),
            'transcription_seconds': round(transcribe_time, 2),
            'total_seconds': round(download_time + transcribe_time, 2),
        }
    }
    
    # Upload result
    S3_CLIENT.put_object(
        Bucket=BUCKET,
        Key=output_key,
        Body=json.dumps(result, indent=2),
        ContentType='application/json'
    )
    print(f"Result saved to s3://{BUCKET}/{output_key}")
    
    # Cleanup
    os.remove(local_audio)
    return result

class TranscribeHandler(BaseHTTPRequestHandler):
    # Suppress default logging for health checks
    def log_message(self, format, *args):
        # Only log non-health-check requests
        if '/health' not in args[0]:
            print(f"{self.address_string()} - {format % args}")
    
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
                # Log timing summary
                timing = result['timing']
                print(f"=== TRANSCRIPTION COMPLETE ===")
                print(f"  File: {input_key}")
                print(f"  Download: {timing['download_seconds']}s")
                print(f"  Transcription: {timing['transcription_seconds']}s")
                print(f"  Total: {timing['total_seconds']}s")
                print(f"==============================")
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())
            except Exception as e:
                print(f"ERROR: {str(e)}")
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
    print(f"Server running on port {port}")
    server.serve_forever()

if __name__ == '__main__':
    main()
