import boto3
import os
import json

ecs = boto3.client('ecs')

def handler(event, context):
    """Trigger ECS task when audio file is uploaded to S3."""
    
    cluster_arn = os.environ['CLUSTER_ARN']
    task_definition = os.environ['TASK_DEFINITION']
    subnet_ids = os.environ['SUBNET_IDS'].split(',')
    security_group_id = os.environ['SECURITY_GROUP_ID']
    
    # Get S3 object info from event
    record = event['Records'][0]
    bucket = record['s3']['bucket']['name']
    key = record['s3']['object']['key']
    
    print(f"Processing: s3://{bucket}/{key}")
    
    # Run ECS task with S3 key as environment variable
    # Note: EC2 launch type with bridge network mode doesn't need networkConfiguration
    response = ecs.run_task(
        cluster=cluster_arn,
        taskDefinition=task_definition,
        launchType='EC2',
        count=1,
        overrides={
            'containerOverrides': [{
                'name': 'parakeet',
                'environment': [
                    {'name': 'INPUT_S3_KEY', 'value': key},
                ]
            }]
        }
    )
    
    task_arn = response['tasks'][0]['taskArn'] if response['tasks'] else 'FAILED'
    print(f"Started ECS task: {task_arn}")
    
    return {
        'statusCode': 200,
        'body': json.dumps({'taskArn': task_arn, 'inputKey': key})
    }
