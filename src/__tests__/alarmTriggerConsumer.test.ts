import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Config } from '../config.js';
import type { AgentState } from '../state/agentState.js';
import type { AgentStateRepository, AlarmTriggerRow } from '../state/repository.js';
import {
  runAlarmTriggerConsumerOnce,
  startAlarmTriggerConsumer,
  type AlarmTriggerBatch,
  type TriggerInvestigationLauncher,
  type TriggerLaunchResult,
} from '../alarm/triggerConsumer.js';

function buildConfig(
  triggerOverrides: Partial<Config['alarm']['trigger']> = {},
  enabled = true
): Config {
  return {
    openrouter: {
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://test.com',
      maxRetries: 1,
      backoffBaseMs: 1,
      backoffMaxMs: 1,
    },
    investigate: {
      model: 'test-model',
      modelFallback: 'test-fallback',
      maxToolIterations: 1,
      maxToolCalls: 1,
      closureEnabled: false,
      closureMaxToolIterations: 1,
      closureMaxToolCalls: 1,
      consecutiveFailureLimit: 1,
      llmTimeoutMs: 1,
    },
    tools: {
      timeoutMs: 1,
      resultMaxChars: 1,
      defaultLookbackMinutes: 1,
      maxLookbackMinutes: 1,
      maxConcurrency: 1,
    },
    healthReport: { s3Uri: 's3://test/report.md' },
    aws: { region: 'us-east-1', maxAttempts: 1 },
    monitoring: { intervalMs: 900000 },
    state: { backend: 'postgres', path: '.test-state.json' },
    database: { ssl: false, maxConnections: 1, idleTimeoutMs: 1 },
    alerts: { slack: { channel: 'slack', timeoutMs: 1 } },
    timeouts: { llmMs: 1, s3Ms: 1 },
    alarm: {
      webhook: { enabled, verifySignature: true, autoconfirm: true },
      trigger: {
        minSeverity: 'CRITICAL',
        cooldownMs: 600000,
        pollMs: 5000,
        coalesceMs: 2000,
        ...triggerOverrides,
      },
    },
  };
}

let rowCounter = 0;

function makeRow(overrides: Partial<AlarmTriggerRow> = {}): AlarmTriggerRow {
  rowCounter += 1;
  return {
    id: `trigger-${rowCounter}`,
    sns_message_id: `sns-${rowCounter}`,
    alarm_arn: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:test',
    alarm_name: 'test-alarm',
    new_state: 'ALARM',
    state_change_time: new Date().toISOString(),
    severity: 'CRITICAL',
    spec_key: 'svc-a',
    payload: {},
    status: 'pending',
    received_at: new Date().toISOString(),
    claimed_at: null,
    processed_at: null,
    run_id: null,
    ...overrides,
  };
}

class FakeAlarmTriggerRepository implements AgentStateRepository {
  rows = new Map<string, AlarmTriggerRow>();
  reclaimCalls: number[] = [];
  claimCalls = 0;
  deferredCalls: string[][] = [];
  completedCalls: Array<{ ids: string[]; runId: string | null }> = [];
  releasedCalls: string[][] = [];
  failedCalls: string[][] = [];
  cooldownLookups: Array<{ specKey: string; withinMs: number }> = [];
  cooldownHits = new Map<string, { runId: string }>();

  seed(...rows: AlarmTriggerRow[]): this {
    for (const row of rows) {
      this.rows.set(row.id, row);
    }
    return this;
  }

  async load(): Promise<AgentState> {
    return { version: 1, observations: {} };
  }

  async save(): Promise<void> {
    return;
  }

  async reclaimStaleClaimedTriggers(olderThanMs: number): Promise<number> {
    this.reclaimCalls.push(olderThanMs);
    let count = 0;
    for (const row of this.rows.values()) {
      if (row.status !== 'claimed') {
        continue;
      }
      const claimedAt = row.claimed_at ? new Date(row.claimed_at).getTime() : 0;
      if (Date.now() - claimedAt >= olderThanMs) {
        row.status = 'pending';
        row.claimed_at = null;
        count += 1;
      }
    }
    return count;
  }

  async countPendingAlarmTriggers(): Promise<number> {
    return [...this.rows.values()].filter(
      (row) =>
        row.status === 'pending' &&
        (row.new_state === 'ALARM' || row.new_state === 'INSUFFICIENT_DATA')
    ).length;
  }

  async claimPendingAlarmTriggers(): Promise<AlarmTriggerRow[]> {
    this.claimCalls += 1;
    const eligible = [...this.rows.values()].filter(
      (row) =>
        row.status === 'pending' &&
        (row.new_state === 'ALARM' || row.new_state === 'INSUFFICIENT_DATA')
    );
    for (const row of eligible) {
      row.status = 'claimed';
      row.claimed_at = new Date().toISOString();
    }
    return eligible.map((row) => ({ ...row }));
  }

  async deferAlarmTriggers(ids: string[]): Promise<void> {
    this.deferredCalls.push(ids);
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row) {
        row.status = 'deferred';
        row.processed_at = new Date().toISOString();
      }
    }
  }

  async completeAlarmTriggers(ids: string[], runId: string | null): Promise<void> {
    this.completedCalls.push({ ids, runId });
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row) {
        row.status = 'done';
        row.run_id = runId;
        row.processed_at = new Date().toISOString();
      }
    }
  }

  async releaseAlarmTriggers(ids: string[]): Promise<void> {
    this.releasedCalls.push(ids);
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row) {
        row.status = 'pending';
        row.claimed_at = null;
      }
    }
  }

  async failAlarmTriggers(ids: string[]): Promise<void> {
    this.failedCalls.push(ids);
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row) {
        row.status = 'error';
        row.processed_at = new Date().toISOString();
      }
    }
  }

  async findRecentLaunchForSpecKey(
    specKey: string,
    withinMs: number
  ): Promise<{ runId: string } | null> {
    this.cooldownLookups.push({ specKey, withinMs });
    return this.cooldownHits.get(specKey) ?? null;
  }
}

class ThrowingClaimRepository extends FakeAlarmTriggerRepository {
  override async claimPendingAlarmTriggers(): Promise<AlarmTriggerRow[]> {
    this.claimCalls += 1;
    throw new Error('connection reset');
  }
}

class SpyLauncher implements TriggerInvestigationLauncher {
  busy = false;
  isBusySequence: boolean[] | null = null;
  calls: AlarmTriggerBatch[] = [];
  launchImpl: ((batch: AlarmTriggerBatch) => Promise<TriggerLaunchResult> | TriggerLaunchResult) | null =
    null;

  isBusy(): boolean {
    if (this.isBusySequence && this.isBusySequence.length > 0) {
      return this.isBusySequence.shift() as boolean;
    }
    return this.busy;
  }

  async launch(batch: AlarmTriggerBatch): Promise<TriggerLaunchResult> {
    this.calls.push(batch);
    if (this.launchImpl) {
      return this.launchImpl(batch);
    }
    return { status: 'launched', runId: `run-${this.calls.length}` };
  }
}

function silentLogger(): Pick<Console, 'log' | 'warn' | 'error'> {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const instantSleep = async (): Promise<void> => {
  return;
};

describe('runAlarmTriggerConsumerOnce', () => {
  it('REQ-F1: is fully inert when disabled — no DB calls, no launch', async () => {
    const repo = new FakeAlarmTriggerRepository();
    repo.seed(makeRow());
    const launcher = new SpyLauncher();
    const config = buildConfig({}, false);

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(outcome.skipped).toBe('disabled');
    expect(repo.reclaimCalls).toHaveLength(0);
    expect(repo.claimCalls).toBe(0);
    expect(launcher.calls).toHaveLength(0);
  });

  it('REQ-F2: claims all pending eligible rows in one pass', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const rows = Array.from({ length: 5 }, (_, index) =>
      makeRow({ spec_key: `svc-${index}` })
    );
    repo.seed(...rows);
    const launcher = new SpyLauncher();
    const config = buildConfig();

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(repo.claimCalls).toBe(1);
    expect(outcome.claimed).toBe(5);
    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0]?.specKeys).toHaveLength(5);
  });

  it('REQ-F3: coalesces a same-spec_key storm into exactly one investigation', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const rows = Array.from({ length: 10 }, () => makeRow({ spec_key: 'svc-storm' }));
    repo.seed(...rows);
    const launcher = new SpyLauncher();
    const config = buildConfig();

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0]?.specKeys).toEqual(['svc-storm']);
    expect(launcher.calls[0]?.triggers).toHaveLength(10);
    expect(outcome.launched).toBe(10);
    for (const row of rows) {
      expect(repo.rows.get(row.id)).toMatchObject({ status: 'done' });
    }
  });

  it('REQ-F3: a multi-spec_key storm still yields one investigation over N specs', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const specKeys: string[] = ['svc-a', 'svc-b', 'svc-c'];
    const rows = Array.from({ length: 9 }, (_, index) =>
      makeRow({ spec_key: specKeys[index % 3] as string })
    );
    repo.seed(...rows);
    const launcher = new SpyLauncher();
    const config = buildConfig();

    await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0]?.specKeys.sort()).toEqual(['svc-a', 'svc-b', 'svc-c']);
    expect(launcher.calls[0]?.triggers).toHaveLength(9);
  });

  it('REQ-F4: defers rows below the minimum severity and excludes them from the batch', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const low = makeRow({ severity: 'HIGH', spec_key: 'svc-low' });
    const high = makeRow({ severity: 'CRITICAL', spec_key: 'svc-high' });
    repo.seed(low, high);
    const launcher = new SpyLauncher();
    const config = buildConfig({ minSeverity: 'CRITICAL' });

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(outcome.deferred).toBe(1);
    expect(repo.rows.get(low.id)).toMatchObject({ status: 'deferred' });
    expect(repo.rows.get(high.id)).toMatchObject({ status: 'done' });
    expect(launcher.calls[0]?.triggers.map((row) => row.id)).toEqual([high.id]);
  });

  it('REQ-F4 boundary: severity exactly at the floor is included, not deferred', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const atFloor = makeRow({ severity: 'HIGH', spec_key: 'svc-floor' });
    repo.seed(atFloor);
    const launcher = new SpyLauncher();
    const config = buildConfig({ minSeverity: 'HIGH' });

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(outcome.deferred).toBe(0);
    expect(launcher.calls).toHaveLength(1);
    expect(repo.rows.get(atFloor.id)).toMatchObject({ status: 'done' });
  });

  it('REQ-F4: null severity is deferred fail-safe and logged', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const nullSeverity = makeRow({ severity: null, spec_key: 'svc-null' });
    repo.seed(nullSeverity);
    const launcher = new SpyLauncher();
    const config = buildConfig();
    const logger = silentLogger();

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger,
    });

    expect(outcome.deferred).toBe(1);
    expect(repo.rows.get(nullSeverity.id)).toMatchObject({ status: 'deferred' });
    expect(logger.warn).toHaveBeenCalled();
    expect(launcher.calls).toHaveLength(0);
  });

  it('REQ-F5: a spec_key in cooldown attaches to the open incident instead of launching', async () => {
    const repo = new FakeAlarmTriggerRepository();
    repo.cooldownHits.set('svc-d', { runId: 'run-prior' });
    const row = makeRow({ spec_key: 'svc-d' });
    repo.seed(row);
    const launcher = new SpyLauncher();
    const config = buildConfig();

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(outcome.attached).toBe(1);
    expect(launcher.calls).toHaveLength(0);
    expect(repo.rows.get(row.id)).toMatchObject({ status: 'done', run_id: 'run-prior' });
  });

  it('REQ-F5: mixed batch attaches the in-cooldown spec_key and launches the other', async () => {
    const repo = new FakeAlarmTriggerRepository();
    repo.cooldownHits.set('svc-d', { runId: 'run-prior' });
    const cooling = makeRow({ spec_key: 'svc-d' });
    const fresh = makeRow({ spec_key: 'svc-e' });
    repo.seed(cooling, fresh);
    const launcher = new SpyLauncher();
    const config = buildConfig();

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(outcome.attached).toBe(1);
    expect(outcome.launched).toBe(1);
    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0]?.specKeys).toEqual(['svc-e']);
    expect(repo.rows.get(cooling.id)).toMatchObject({ status: 'done', run_id: 'run-prior' });
    expect(repo.rows.get(fresh.id)).toMatchObject({ status: 'done' });
  });

  it('REQ-F5 boundary: no cooldown hit (just outside window) launches normally', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const row = makeRow({ spec_key: 'svc-d' });
    repo.seed(row);
    const launcher = new SpyLauncher();
    const config = buildConfig();

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(outcome.attached).toBe(0);
    expect(outcome.launched).toBe(1);
    expect(repo.cooldownLookups).toEqual([{ specKey: 'svc-d', withinMs: config.alarm.trigger.cooldownMs }]);
  });

  it('REQ-F6: in-flight at the pre-claim check leaves rows untouched and pending', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const row = makeRow();
    repo.seed(row);
    const launcher = new SpyLauncher();
    launcher.busy = true;
    const config = buildConfig();

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(outcome.skipped).toBe('in-flight');
    expect(repo.claimCalls).toBe(0);
    expect(launcher.calls).toHaveLength(0);
    expect(repo.rows.get(row.id)).toMatchObject({ status: 'pending' });
  });

  it('REQ-F6: busy only at the final pre-launch check releases the batch back to pending', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const row = makeRow({ spec_key: 'svc-mid' });
    repo.seed(row);
    const launcher = new SpyLauncher();
    launcher.isBusySequence = [false, false, true];
    const config = buildConfig();

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(outcome.skipped).toBe('in-flight');
    expect(outcome.released).toBe(1);
    expect(launcher.calls).toHaveLength(0);
    expect(repo.rows.get(row.id)).toMatchObject({ status: 'pending', claimed_at: null });
  });

  it('REQ-F6: once no longer busy, the next tick launches normally', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const row = makeRow({ spec_key: 'svc-next' });
    repo.seed(row);
    const launcher = new SpyLauncher();
    launcher.busy = true;
    const config = buildConfig();

    await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });
    expect(launcher.calls).toHaveLength(0);

    launcher.busy = false;
    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(outcome.launched).toBe(1);
    expect(launcher.calls).toHaveLength(1);
  });

  it('REQ-F7: happy path launches a 2-entry batch and marks both rows done', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const a = makeRow({ spec_key: 'svc-a' });
    const b = makeRow({ spec_key: 'svc-b' });
    repo.seed(a, b);
    const launcher = new SpyLauncher();
    const config = buildConfig();

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0]?.triggers).toHaveLength(2);
    expect(outcome.launched).toBe(2);
    expect(repo.rows.get(a.id)?.run_id).toBe('run-1');
    expect(repo.rows.get(b.id)?.run_id).toBe('run-1');
  });

  it('REQ-F7: an empty queue returns quickly with no launch', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const launcher = new SpyLauncher();
    const config = buildConfig();

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(outcome.skipped).toBe('empty');
    expect(repo.claimCalls).toBe(0);
    expect(launcher.calls).toHaveLength(0);
  });

  it('REQ-F8: a thrown launch marks the batch rows as error', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const row = makeRow({ spec_key: 'svc-fail' });
    repo.seed(row);
    const launcher = new SpyLauncher();
    launcher.launchImpl = () => {
      throw new Error('investigate crashed');
    };
    const config = buildConfig();
    const logger = silentLogger();

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger,
    });

    expect(outcome.failed).toBe(1);
    expect(repo.rows.get(row.id)).toMatchObject({ status: 'error' });
    expect(logger.error).toHaveBeenCalled();
  });

  it('REQ-F8: an error-status launch result marks the batch rows as error', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const row = makeRow({ spec_key: 'svc-fail' });
    repo.seed(row);
    const launcher = new SpyLauncher();
    launcher.launchImpl = () => ({ status: 'error', message: 'llm timeout' });
    const config = buildConfig();

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(outcome.failed).toBe(1);
    expect(repo.rows.get(row.id)).toMatchObject({ status: 'error' });
  });

  it('REQ-F8: a busy launch result releases the batch back to pending', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const row = makeRow({ spec_key: 'svc-busy' });
    repo.seed(row);
    const launcher = new SpyLauncher();
    launcher.launchImpl = () => ({ status: 'busy' });
    const config = buildConfig();

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(outcome.released).toBe(1);
    expect(repo.rows.get(row.id)).toMatchObject({ status: 'pending', claimed_at: null });
  });

  it('REQ-F8: a claim-time DB error rolls back and leaves rows pending', async () => {
    const repo = new ThrowingClaimRepository();
    const row = makeRow();
    repo.seed(row);
    const launcher = new SpyLauncher();
    const config = buildConfig();

    await expect(
      runAlarmTriggerConsumerOnce({
        config,
        repository: repo,
        launcher,
        sleep: instantSleep,
        logger: silentLogger(),
      })
    ).rejects.toThrow('connection reset');

    expect(repo.rows.get(row.id)).toMatchObject({ status: 'pending' });
    expect(launcher.calls).toHaveLength(0);
  });

  it('D4: INSUFFICIENT_DATA rows are ignored (marked done, no run) and not launched', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const row = makeRow({ new_state: 'INSUFFICIENT_DATA' });
    repo.seed(row);
    const launcher = new SpyLauncher();
    const config = buildConfig();

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(outcome.ignored).toBe(1);
    expect(repo.rows.get(row.id)).toMatchObject({ status: 'done', run_id: null });
    expect(launcher.calls).toHaveLength(0);
  });

  it('D4: OK rows are never claimed and stay pending for T7', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const row = makeRow({ new_state: 'OK' });
    repo.seed(row);
    const launcher = new SpyLauncher();
    const config = buildConfig();

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(outcome.skipped).toBe('empty');
    expect(repo.rows.get(row.id)).toMatchObject({ status: 'pending' });
  });

  it('D6: reclaims stale claimed rows at the start of the tick', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const stale = makeRow({
      status: 'claimed',
      claimed_at: new Date(Date.now() - 60_000).toISOString(),
    });
    repo.seed(stale);
    const launcher = new SpyLauncher();
    const config = buildConfig({ pollMs: 1000, coalesceMs: 500 });

    await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(repo.reclaimCalls).toEqual([Math.max(1000 * 3, 500 + 1000)]);
    expect(repo.rows.get(stale.id)?.status).not.toBe('claimed');
  });

  it('D6: does not reclaim while an investigation is in flight (busy)', async () => {
    // A live investigation holds its batch in `claimed` for the whole launch; the isBusy guard,
    // not the reclaim timeout, must keep those rows from being flipped back to pending.
    const repo = new FakeAlarmTriggerRepository();
    const inFlight = makeRow({
      status: 'claimed',
      claimed_at: new Date(Date.now() - 60_000).toISOString(),
    });
    repo.seed(inFlight);
    const launcher = new SpyLauncher();
    launcher.busy = true;
    const config = buildConfig({ pollMs: 1000, coalesceMs: 500 });

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    expect(outcome.skipped).toBe('in-flight');
    expect(repo.reclaimCalls).toHaveLength(0);
    expect(repo.rows.get(inFlight.id)?.status).toBe('claimed');
  });

  it('D8: negative/zero coalesceMs is clamped to zero and never throws', async () => {
    const repo = new FakeAlarmTriggerRepository();
    const row = makeRow({ spec_key: 'svc-clamp' });
    repo.seed(row);
    const launcher = new SpyLauncher();
    const config = buildConfig({ coalesceMs: -500 });
    const sleepSpy = vi.fn(async (_ms: number) => {});

    const outcome = await runAlarmTriggerConsumerOnce({
      config,
      repository: repo,
      launcher,
      sleep: sleepSpy,
      logger: silentLogger(),
    });

    expect(sleepSpy).toHaveBeenCalledWith(0);
    expect(outcome.launched).toBe(1);
  });
});

describe('startAlarmTriggerConsumer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('REQ-F1: schedules no timer when disabled and stop() is a no-op', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const repo = new FakeAlarmTriggerRepository();
    const launcher = new SpyLauncher();
    const config = buildConfig({}, false);

    const handle = startAlarmTriggerConsumer({ config, repository: repo, launcher });

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(() => handle.stop()).not.toThrow();
  });

  it('overlap guard: a slow tick is never re-entered by the interval', async () => {
    vi.useFakeTimers();
    const repo = new FakeAlarmTriggerRepository();
    let active = 0;
    let maxActive = 0;
    const originalCount = repo.countPendingAlarmTriggers.bind(repo);
    repo.countPendingAlarmTriggers = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 100));
      active -= 1;
      return originalCount();
    };
    const launcher = new SpyLauncher();
    const config = buildConfig({ pollMs: 10, coalesceMs: 0 });

    const handle = startAlarmTriggerConsumer({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    await vi.advanceTimersByTimeAsync(60);
    handle.stop();

    expect(maxActive).toBeLessThanOrEqual(1);
  });

  it('stop() prevents further ticks', async () => {
    vi.useFakeTimers();
    const repo = new FakeAlarmTriggerRepository();
    const launcher = new SpyLauncher();
    const config = buildConfig({ pollMs: 10, coalesceMs: 0 });

    const handle = startAlarmTriggerConsumer({
      config,
      repository: repo,
      launcher,
      sleep: instantSleep,
      logger: silentLogger(),
    });

    await vi.advanceTimersByTimeAsync(5);
    handle.stop();
    const claimCallsAtStop = repo.claimCalls;

    await vi.advanceTimersByTimeAsync(100);

    expect(repo.claimCalls).toBe(claimCallsAtStop);
  });
});
