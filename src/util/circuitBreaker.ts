/**
 * Counts consecutive failures and "trips" once a limit is reached. Used by the
 * Investigate tool loop to abort immediately when a dependency is hard-down,
 * rather than burning the whole tool budget on guaranteed failures.
 *
 * A success resets the count, so only an unbroken run of failures trips it.
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;

  constructor(private readonly limit: number) {}

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  get tripped(): boolean {
    return this.consecutiveFailures >= this.limit;
  }
}
