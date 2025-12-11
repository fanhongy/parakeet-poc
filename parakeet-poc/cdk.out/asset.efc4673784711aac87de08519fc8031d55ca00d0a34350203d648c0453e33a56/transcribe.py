#!/usr/bin/env python3
"""
Parakeet transcription script for ECS.
Downloads audio from S3, transcribes with Parakeet, uploads result to S3.
"""
import os
import sys
import time
import json
import boto3
import nemo.collections.asr as nemo_asr

def main():
    # Environment variables
    bucket = os.environ['S3_BUCKET']
    input_key = os.environ['INPUT_S3_KEY']
    model_name = os.environ.get('PARAKEET_MODEL', 'nvidia/parakeet-rnnt-1.1b')
    
    # Derive output key
    base_name = os.path.splitext(os.path.basename(input_key))[0]
    output_key = f"output/{base_name}_transcript.json"
    
    s3 = boto3.client('s3')
    local_audio = f"/tmp/{os.path.basename(input_key)}"
    
    print(f"Starting transcription job")
    print(f"  Model: {model_name}")
    print(f"  Input: s3://{bucket}/{input_key}")
    print(f"  Output: s3://{bucket}/{output_key}")
    
    # Download audio from S3
    print("Downloading audio from S3...")
    download_start = time.time()
    s3.download_file(bucket, input_key, local_audio)
    download_time = time.time() - download_start
    print(f"Download completed in {download_time:.2f}s")
    
    # Load Parakeet model
    print(f"Loading model: {model_name}...")
    model_start = time.time()
    asr_model = nemo_asr.models.ASRModel.from_pretrained(model_name)
    model_time = time.time() - model_start
    print(f"Model loaded in {model_time:.2f}s")
    
    # Transcribe
    print("Starting transcription...")
    transcribe_start = time.time()
    transcriptions = asr_model.transcribe([local_audio])
    transcribe_time = time.time() - transcribe_start
    print(f"Transcription completed in {transcribe_time:.2f}s")
    
    # Prepare result
    result = {
        'input_file': input_key,
        'model': model_name,
        'transcription': transcriptions[0] if transcriptions else '',
        'timing': {
            'download_seconds': round(download_time, 2),
            'model_load_seconds': round(model_time, 2),
            'transcription_seconds': round(transcribe_time, 2),
            'total_seconds': round(download_time + model_time + transcribe_time, 2),
        }
    }
    
    # Upload result to S3
    print("Uploading transcript to S3...")
    s3.put_object(
        Bucket=bucket,
        Key=output_key,
        Body=json.dumps(result, indent=2),
        ContentType='application/json'
    )
    
    print(f"Done! Transcript saved to s3://{bucket}/{output_key}")
    print(f"Total processing time: {result['timing']['total_seconds']}s")
    
    # Cleanup
    os.remove(local_audio)

if __name__ == '__main__':
    main()
