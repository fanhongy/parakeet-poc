import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
interface ParakeetPocStackProps extends cdk.StackProps {
    vpcId: string;
    parakeetModel: string;
    ecrRepoName?: string;
    ecrImageTag?: string;
}
export declare class ParakeetPocStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ParakeetPocStackProps);
    private createParakeetService;
}
export {};
