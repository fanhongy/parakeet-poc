import os
import json
import urllib.request
import urllib.error

def handler(event, context):
    """Trigger transcription via ECS service API when audio is uploaded."""
    
    service_url = os.environ['SERVICE_URL']
    
    # Get S3 object info from event
    record = event['Records'][0]
    bucket = record['s3']['bucket']['name']
    key = record['s3']['object']['key']
    
    print(f"Processing: s3://{bucket}/{key}")
    
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
