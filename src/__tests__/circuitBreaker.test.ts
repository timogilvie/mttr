import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../util/circuitBreaker.js';
import { awsRetryConfig } from '../util/awsRetry.js';

describe('CircuitBreaker', () => {
  it('is not tripped before reaching the limit', () => {
    const breaker = new CircuitBreaker(3);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.failures).toBe(2);
    expect(breaker.tripped).toBe(false);
  });

  it('trips once consecutive failures reach the limit', () => {
    const breaker = new CircuitBreaker(3);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.tripped).toBe(true);
  });

  it('resets the count on success', () => {
    const breaker = new CircuitBreaker(3);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.failures).toBe(0);
    breaker.recordFailure();
    expect(breaker.tripped).toBe(false);
  });
});

describe('awsRetryConfig', () => {
  it('returns adaptive retry mode with the given max attempts', () => {
    expect(awsRetryConfig(5)).toEqual({ maxAttempts: 5, retryMode: 'adaptive' });
  });
});
