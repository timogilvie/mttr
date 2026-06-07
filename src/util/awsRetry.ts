/**
 * Standard retry configuration for AWS SDK v3 clients. `adaptive` mode enables
 * the SDK's client-side rate-limiting + token-bucket backoff, which handles
 * ThrottlingException / TooManyRequestsException without bespoke code. Every
 * CloudWatch/Logs client in the tool layer is constructed with this.
 */
export interface AwsRetryConfig {
  maxAttempts: number;
  retryMode: 'adaptive';
}

export function awsRetryConfig(maxAttempts: number): AwsRetryConfig {
  return { maxAttempts, retryMode: 'adaptive' };
}
