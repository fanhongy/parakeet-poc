#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("source-map-support/register");
const cdk = require("aws-cdk-lib");
const parakeet_poc_stack_1 = require("../lib/parakeet-poc-stack");
const app = new cdk.App();
new parakeet_poc_stack_1.ParakeetPocStack(app, 'ParakeetPocStack', {
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        // region: 'us-west-2',
        region: 'us-east-1',
    },
    vpcId: 'vpc-0d6c5654761cfd6fd', //us-east-1
    // vpcId: 'vpc-085e137e76ba56268', //us-west-2
    // Easy to switch model variants:
    // - c (default, faster)
    // - parakeet-ctc-1.1b
    // - parakeet-tdt-1.1b (best accuracy)
    // Model variants:
    // - nvidia/parakeet-rnnt-1.1b (NeMo 24.05+)
    // - nvidia/parakeet-ctc-1.1b (NeMo 24.05+)
    // - nvidia/parakeet-tdt-1.1b (NeMo 24.05+)
    // - nvidia/parakeet-ctc-0.6b (NeMo 24.05+, smaller/faster)
    // - nvidia/parakeet-tdt-0.6b-v2 (NeMo 24.09+, requires newer container)
    parakeetModel: 'nvidia/parakeet-ctc-0.6b',
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGFyYWtlZXQtcG9jLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vYmluL3BhcmFrZWV0LXBvYy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFDQSx1Q0FBcUM7QUFDckMsbUNBQW1DO0FBQ25DLGtFQUE2RDtBQUU3RCxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztBQUUxQixJQUFJLHFDQUFnQixDQUFDLEdBQUcsRUFBRSxrQkFBa0IsRUFBRTtJQUM1QyxHQUFHLEVBQUU7UUFDSCxPQUFPLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxtQkFBbUI7UUFDeEMsdUJBQXVCO1FBQ3ZCLE1BQU0sRUFBRSxXQUFXO0tBQ3BCO0lBQ0QsS0FBSyxFQUFFLHVCQUF1QixFQUFFLFdBQVc7SUFDM0MsOENBQThDO0lBQzlDLGlDQUFpQztJQUNqQyx3QkFBd0I7SUFDeEIsc0JBQXNCO0lBQ3RCLHNDQUFzQztJQUN0QyxrQkFBa0I7SUFDbEIsNENBQTRDO0lBQzVDLDJDQUEyQztJQUMzQywyQ0FBMkM7SUFDM0MsMkRBQTJEO0lBQzNELHdFQUF3RTtJQUN4RSxhQUFhLEVBQUUsMEJBQTBCO0NBQzFDLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIiMhL3Vzci9iaW4vZW52IG5vZGVcbmltcG9ydCAnc291cmNlLW1hcC1zdXBwb3J0L3JlZ2lzdGVyJztcbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBQYXJha2VldFBvY1N0YWNrIH0gZnJvbSAnLi4vbGliL3BhcmFrZWV0LXBvYy1zdGFjayc7XG5cbmNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG5cbm5ldyBQYXJha2VldFBvY1N0YWNrKGFwcCwgJ1BhcmFrZWV0UG9jU3RhY2snLCB7XG4gIGVudjoge1xuICAgIGFjY291bnQ6IHByb2Nlc3MuZW52LkNES19ERUZBVUxUX0FDQ09VTlQsXG4gICAgLy8gcmVnaW9uOiAndXMtd2VzdC0yJyxcbiAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICB9LFxuICB2cGNJZDogJ3ZwYy0wZDZjNTY1NDc2MWNmZDZmZCcsIC8vdXMtZWFzdC0xXG4gIC8vIHZwY0lkOiAndnBjLTA4NWUxMzdlNzZiYTU2MjY4JywgLy91cy13ZXN0LTJcbiAgLy8gRWFzeSB0byBzd2l0Y2ggbW9kZWwgdmFyaWFudHM6XG4gIC8vIC0gYyAoZGVmYXVsdCwgZmFzdGVyKVxuICAvLyAtIHBhcmFrZWV0LWN0Yy0xLjFiXG4gIC8vIC0gcGFyYWtlZXQtdGR0LTEuMWIgKGJlc3QgYWNjdXJhY3kpXG4gIC8vIE1vZGVsIHZhcmlhbnRzOlxuICAvLyAtIG52aWRpYS9wYXJha2VldC1ybm50LTEuMWIgKE5lTW8gMjQuMDUrKVxuICAvLyAtIG52aWRpYS9wYXJha2VldC1jdGMtMS4xYiAoTmVNbyAyNC4wNSspXG4gIC8vIC0gbnZpZGlhL3BhcmFrZWV0LXRkdC0xLjFiIChOZU1vIDI0LjA1KylcbiAgLy8gLSBudmlkaWEvcGFyYWtlZXQtY3RjLTAuNmIgKE5lTW8gMjQuMDUrLCBzbWFsbGVyL2Zhc3RlcilcbiAgLy8gLSBudmlkaWEvcGFyYWtlZXQtdGR0LTAuNmItdjIgKE5lTW8gMjQuMDkrLCByZXF1aXJlcyBuZXdlciBjb250YWluZXIpXG4gIHBhcmFrZWV0TW9kZWw6ICdudmlkaWEvcGFyYWtlZXQtY3RjLTAuNmInLFxufSk7XG5cbiJdfQ==