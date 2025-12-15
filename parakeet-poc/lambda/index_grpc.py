"""
Lambda handler for triggering transcription via gRPC.

Routes to different services based on S3 prefix:
- input/ -> Standard service (30s chunks, up to 30 min)
- input-nochunk/ -> No-chunk service (experimental, up to 15 min)

Uses gRPC for significantly better performance than HTTP:
- Binary protocol with efficient serialization (protobuf)
- HTTP/2 multiplexing
- Lower latency and reduced overhead
"""
import os
import json
import grpc

# Import generated protobuf classes (bundled in Lambda layer)
import transcribe_pb2
import transcribe_pb2_grpc


def handler(event, context):
    """Trigger transcription via ECS gRPC service when audio is uploaded."""
    
    standard_host = os.environ['STANDARD_SERVICE_HOST']
    standard_port = os.environ.get('STANDARD_SERVICE_PORT', '50051')
    no_chunk_host = os.environ.get('NO_CHUNK_SERVICE_HOST', '')
    no_chunk_port = os.environ.get('NO_CHUNK_SERVICE_PORT', '50051')
    standard_prefix = os.environ.get('STANDARD_PREFIX', 'input/')
    no_chunk_prefix = os.environ.get('NO_CHUNK_PREFIX', 'input-nochunk/')
    
    # Get S3 object info from event
    record = event['Records'][0]
    bucket = record['s3']['bucket']['name']
    key = record['s3']['object']['key']
    
    # Route to appropriate service based on prefix
    if key.startswith(no_chunk_prefix) and no_chunk_host:
        service_host = no_chunk_host
        service_port = no_chunk_port
        service_name = 'no-chunk'
    else:
        service_host = standard_host
        service_port = standard_port
        service_name = 'standard'
    
    print(f"Processing: s3://{bucket}/{key} via {service_name} gRPC service")
    
    # Create gRPC channel with appropriate options for long-running calls
    channel_options = [
        ('grpc.max_send_message_length', 100 * 1024 * 1024),  # 100MB
        ('grpc.max_receive_message_length', 100 * 1024 * 1024),  # 100MB
        ('grpc.keepalive_time_ms', 30000),  # 30s keepalive
        ('grpc.keepalive_timeout_ms', 10000),  # 10s timeout
        ('grpc.enable_retries', 1),
    ]
    
    target = f'{service_host}:{service_port}'
    
    try:
        with grpc.insecure_channel(target, options=channel_options) as channel:
            stub = transcribe_pb2_grpc.TranscribeServiceStub(channel)
            
            # Call transcribe with 15 minute timeout (Lambda max)
            request = transcribe_pb2.TranscribeRequest(input_key=key)
            response = stub.Transcribe(request, timeout=900)
            
            if response.error:
                print(f"Transcription error: {response.error}")
                return {
                    'statusCode': 400,
                    'body': json.dumps({'error': response.error})
                }
            
            # Convert protobuf response to dict for JSON serialization
            result = {
                'input_file': response.input_file,
                'model': response.model,
                'transcription': response.transcription,
                'segments': [
                    {
                        'index': s.index,
                        'start_time': s.start_time,
                        'end_time': s.end_time,
                        'text': s.text,
                        'processing_time': s.processing_time,
                    }
                    for s in response.segments
                ],
                'audio_duration_seconds': response.audio_duration_seconds,
                'timing': {
                    'download_seconds': response.timing.download_seconds,
                    'prep_seconds': response.timing.prep_seconds,
                    'transcription_seconds': response.timing.transcription_seconds,
                    'total_seconds': response.timing.total_seconds,
                },
                'processing_config': {
                    'chunking_enabled': response.processing_config.chunking_enabled,
                    'chunk_duration_seconds': response.processing_config.chunk_duration_seconds,
                    'total_chunks': response.processing_config.total_chunks,
                    'max_audio_duration_minutes': response.processing_config.max_audio_duration_minutes,
                },
                'memory': {
                    'gpu_peak_gb': response.memory.gpu_peak_gb,
                    'gpu_total_gb': response.memory.gpu_total_gb,
                    'system_ram_used_gb': response.memory.system_ram_used_gb,
                    'system_ram_total_gb': response.memory.system_ram_total_gb,
                },
            }
            
            print(f"Transcription complete: {result.get('timing', {})}")
            return {
                'statusCode': 200,
                'body': json.dumps(result)
            }
            
    except grpc.RpcError as e:
        error_code = e.code()
        error_details = e.details()
        print(f"gRPC Error [{error_code}]: {error_details}")
        
        status_code = 500
        if error_code == grpc.StatusCode.INVALID_ARGUMENT:
            status_code = 400
        elif error_code == grpc.StatusCode.DEADLINE_EXCEEDED:
            status_code = 504
        elif error_code == grpc.StatusCode.UNAVAILABLE:
            status_code = 503
        
        return {
            'statusCode': status_code,
            'body': json.dumps({'error': error_details, 'code': str(error_code)})
        }
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
