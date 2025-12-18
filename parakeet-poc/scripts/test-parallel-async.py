#!/usr/bin/env python3
"""
Ultra-fast async Lambda invocation test (fire-and-forget).
Uses Event invocation type - doesn't wait for responses.

Usage:
    python3 scripts/test-parallel-async.py --count 100
    python3 scripts/test-parallel-async.py --count 1000 --key input/4m36s.wav
"""

import boto3
import json
import time
import argparse
from datetime import datetime

lambda_client = boto3.client('lambda')
sts_client = boto3.client('sts')

def get_account_id():
    """Get AWS account ID."""
    return sts_client.get_caller_identity()['Account']

def invoke_async(function_name, payload):
    """Fire-and-forget Lambda invocation."""
    try:
        response = lambda_client.invoke(
            FunctionName=function_name,
            InvocationType='Event',  # Async - no response wait
            Payload=json.dumps(payload)
        )
        return response['StatusCode'] == 202  # 202 = Accepted
    except Exception as e:
        print(f"Error: {e}")
        return False

def run_async_test(function_name, bucket, s3_key, count):
    """Run async load test - fire all requests immediately."""
    
    payload = {
        "Records": [{
            "s3": {
                "bucket": {"name": bucket},
                "object": {"key": s3_key}
            }
        }]
    }
    
    print("=" * 60)
    print("  Ultra-Fast Async Lambda Test (Fire-and-Forget)")
    print("=" * 60)
    print(f"Function:     {function_name}")
    print(f"Bucket:       {bucket}")
    print(f"Key:          {s3_key}")
    print(f"Total:        {count} invocations")
    print(f"Type:         Event (async, no response wait)")
    print("=" * 60)
    print()
    
    print(f"Firing {count} async invocations...")
    start_time = time.time()
    
    accepted = 0
    failed = 0
    
    for i in range(1, count + 1):
        if invoke_async(function_name, payload):
            accepted += 1
        else:
            failed += 1
        
        # Progress every 50 requests
        if i % 50 == 0 or i == count:
            elapsed = time.time() - start_time
            rate = i / elapsed if elapsed > 0 else 0
            print(f"  Progress: {i}/{count} ({rate:.0f} req/s)", flush=True)
    
    end_time = time.time()
    total_duration = end_time - start_time
    
    print()
    print("=" * 60)
    print("  Results")
    print("=" * 60)
    print(f"Total time:       {total_duration:.2f}s")
    print(f"Throughput:       {count / total_duration:.0f} req/s")
    print(f"Accepted (202):   {accepted}")
    print(f"Failed:           {failed}")
    print()
    print("Note: Lambda accepted requests but processing happens async.")
    print("Check ECS logs and S3 output to verify actual processing.")
    print()
    print("=" * 60)
    print("  Monitor Completion")
    print("=" * 60)
    print()
    print("Option 1: Watch S3 output folder (recommended)")
    print(f"  ./scripts/monitor-completion.sh {count} 10")
    print()
    print("Option 2: Manual S3 check")
    print(f"  watch -n 5 'aws s3 ls s3://{bucket}/output/ | wc -l'")
    print()
    print("Option 3: Check CloudWatch metrics")
    print("  ./scripts/check-metrics.sh")
    print()
    print("Option 4: Tail ECS logs")
    print("  aws logs tail /ecs/parakeet-poc --follow --since 5m")

def main():
    parser = argparse.ArgumentParser(description='Ultra-fast async Lambda test')
    parser.add_argument('--count', type=int, default=100, 
                        help='Number of invocations (default: 100)')
    parser.add_argument('--key', type=str, default='input/4m36s.wav', 
                        help='S3 key (default: input/4m36s.wav)')
    parser.add_argument('--function', type=str, 
                        default='ParakeetPocStack-TriggerLambda2FDB819B-abqQxFL5qLxD', 
                        help='Lambda function name')
    
    args = parser.parse_args()
    
    account_id = get_account_id()
    bucket = f"parakeet-poc-{account_id}-us-east-1"
    
    run_async_test(
        function_name=args.function,
        bucket=bucket,
        s3_key=args.key,
        count=args.count
    )

if __name__ == '__main__':
    main()
