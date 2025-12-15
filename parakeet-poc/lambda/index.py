import os
import json
import urllib.request
import urllib.error

def handler(event, context):
    """Trigger transcription via ECS service API when audio is uploaded.
    
    Routes to different services based on S3 prefix:
    - input/ -> Standard service (30s chunks, up to 30 min)
    - input-nochunk/ -> No-chunk service (experimental, up to 15 min)
    """
    
    standard_url = os.environ['STANDARD_SERVICE_URL']
    no_chunk_url = os.environ.get('NO_CHUNK_SERVICE_URL', '')
    standard_prefix = os.environ.get('STANDARD_PREFIX', 'input/')
    no_chunk_prefix = os.environ.get('NO_CHUNK_PREFIX', 'input-nochunk/')
    
    # Get S3 object info from event
    record = event['Records'][0]
    bucket = record['s3']['bucket']['name']
    key = record['s3']['object']['key']
    
    # Route to appropriate service based on prefix
    if key.startswith(no_chunk_prefix) and no_chunk_url:
        service_url = no_chunk_url
        service_name = 'no-chunk'
    else:
        service_url = standard_url
        service_name = 'standard'
    
    print(f"Processing: s3://{bucket}/{key} via {service_name} service")
    
    # Call ECS service to transcribe
    url = f"{service_url}/transcribe"
    data = json.dumps({'input_key': key}).encode('utf-8')
    
    req = urllib.request.Request(
        url,
        data=data,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    
    try:
        with urllib.request.urlopen(req, timeout=900) as response:
            result = json.loads(response.read().decode('utf-8'))
            print(f"Transcription complete: {result.get('timing', {})}")
            return {
                'statusCode': 200,
                'body': json.dumps(result)
            }
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8')
        print(f"HTTP Error {e.code}: {error_body}")
        return {
            'statusCode': e.code,
            'body': error_body
        }
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
