import type { Config } from '../config.js';
import type { AgentStateRepository, AlarmTriggerRow } from '../state/repository.js';
import type { Severity } from '../types.js';

/**
 * T6 seam (design doc §5.4). The consumer depends only on this interface — never on the
 * Orchestrator directly — so it stays unit-testable and T6 can implement `launch` independently.
 */
export interface AlarmTriggerBatch {
  /** Coalesced, eligible ALARM rows: post severity-gate, post-cooldown. */
  triggers: AlarmTriggerRow[];
  /** Distinct `spec_key`s represented in `triggers`. */
  specKeys: string[];
}

export type TriggerLaunchResult =
  | { status: 'launched'; runId: string }
  | { status: 'busy' }
  | { status: 'error'; message: string };

export interface TriggerInvestigationLauncher {
  /** Mirrors the Orchestrator's `investigateInFlight` flag. */
  isBusy(): boolean;
  launch(batch: AlarmTriggerBatch): Promise<TriggerLaunchResult>;
}

export interface AlarmTriggerConsumerDeps {
  config: Config;
  repository: AgentStateRepository;
  launcher: TriggerInvestigationLauncher;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable debounce timer for tests; defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export type TickSkipReason = 'disabled' | 'in-flight' | 'empty';

export interface TickOutcome {
  skipped?: TickSkipReason;
  claimed: number;
  deferred: number;
  attached: number;
  ignored: number;
  launched: number;
  released: number;
  failed: number;
}

export interface AlarmTriggerConsumerHandle {
  stop(): void;
}

const SEVERITY_RANK: Record<Severity, number> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

/** Null/unparseable severity ranks below every real severity — fail-safe defer, never fail-open. */
function severityRank(value: string | null): number {
  if (value !== null && Object.prototype.hasOwnProperty.call(SEVERITY_RANK, value)) {
    return SEVERITY_RANK[value as Severity];
  }
  return -1;
}

function clampNonNegative(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function emptyOutcome(skipped?: TickSkipReason): TickOutcome {
  return {
    ...(skipped ? { skipped } : {}),
    claimed: 0,
    deferred: 0,
    attached: 0,
    ignored: 0,
    launched: 0,
    released: 0,
    failed: 0,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one deterministic poll tick: drain, coalesce, severity-gate, cooldown-attach, and
 * (single-flight permitting) launch. See design doc §5.3 and plan.md §4.2/§6 for the full
 * algorithm and edge-case rationale.
 */
export async function runAlarmTriggerConsumerOnce(
  deps: AlarmTriggerConsumerDeps
): Promise<TickOutcome> {
  const { config, repository, launcher } = deps;
  const logger = deps.logger ?? console;
  const sleep = deps.sleep ?? defaultSleep;
  const trigger = config.alarm.trigger;

  if (!config.alarm.webhook.enabled) {
    return emptyOutcome('disabled');
  }

  // D6: self-heal rows stranded in `claimed` by a crash between claim and launch. Bounded by a
  // multiple of the poll/coalesce cadence so a healthy in-progress tick is never reclaimed.
  const reclaimTimeoutMs = Math.max(trigger.pollMs * 3, trigger.coalesceMs + trigger.pollMs);
  const reclaimed = await repository.reclaimStaleClaimedTriggers?.(reclaimTimeoutMs);
  if (reclaimed) {
    logger.warn(`[AlarmTriggerConsumer] Reclaimed ${reclaimed} stale claimed trigger(s) to pending`);
  }

  // Concurrency: queue, don't preempt. Checked again after the debounce and again before launch —
  // no TOCTOU because JS is single-threaded and the in-flight flag flips synchronously on entry.
  if (launcher.isBusy()) {
    return emptyOutcome('in-flight');
  }

  const pendingCount = (await repository.countPendingAlarmTriggers?.()) ?? 0;
  if (pendingCount === 0) {
    return emptyOutcome('empty');
  }

  // D8: debounce before claiming so a burst landing during the window is captured in one batch.
  // A row arriving after the window is picked up next tick, never merged retroactively.
  await sleep(clampNonNegative(trigger.coalesceMs));

  if (launcher.isBusy()) {
    return emptyOutcome('in-flight');
  }

  // D3: short claim transaction only — no locks held across the (potentially long) investigation.
  const claimed = (await repository.claimPendingAlarmTriggers?.()) ?? [];
  if (claimed.length === 0) {
    return emptyOutcome('empty');
  }

  const outcome = emptyOutcome();
  outcome.claimed = claimed.length;

  // D4: INSUFFICIENT_DATA is terminal-ignored (no investigation); OK rows are never claimed here
  // (excluded by the claim query) and are left `pending` for T7.
  const insufficientIds: string[] = [];
  const alarmRows: AlarmTriggerRow[] = [];
  for (const row of claimed) {
    if (row.new_state === 'INSUFFICIENT_DATA') {
      insufficientIds.push(row.id);
    } else {
      alarmRows.push(row);
    }
  }

  if (insufficientIds.length > 0) {
    await repository.completeAlarmTriggers?.(insufficientIds, null);
    outcome.ignored = insufficientIds.length;
    logger.log(
      `[AlarmTriggerConsumer] Ignored ${insufficientIds.length} INSUFFICIENT_DATA trigger(s), no investigation`
    );
  }

  const deferIds: string[] = [];
  const eligible: AlarmTriggerRow[] = [];
  for (const row of alarmRows) {
    if (row.severity === null) {
      deferIds.push(row.id);
      logger.warn(`[AlarmTriggerConsumer] Trigger ${row.id} has no severity; deferring (fail-safe)`);
      continue;
    }
    if (severityRank(row.severity) < severityRank(trigger.minSeverity)) {
      deferIds.push(row.id);
      continue;
    }
    if (!row.spec_key) {
      deferIds.push(row.id);
      logger.warn(
        `[AlarmTriggerConsumer] Trigger ${row.id} missing spec_key; deferring (fail-safe, cannot coalesce/cooldown)`
      );
      continue;
    }
    eligible.push(row);
  }

  if (deferIds.length > 0) {
    await repository.deferAlarmTriggers?.(deferIds);
    outcome.deferred = deferIds.length;
  }

  // Coalesce: group eligible ALARM rows by spec_key so a storm becomes one investigation.
  const groups = new Map<string, AlarmTriggerRow[]>();
  for (const row of eligible) {
    const key = row.spec_key as string;
    const list = groups.get(key);
    if (list) {
      list.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const launchRows: AlarmTriggerRow[] = [];
  const specKeys: string[] = [];

  for (const [specKey, rows] of groups) {
    // D5: cooldown ledger is `alarm_triggers` itself. A recent launched row for this spec_key
    // means "attach, don't launch" — link the new rows to the prior run.
    const cooldownHit = await repository.findRecentLaunchForSpecKey?.(
      specKey,
      trigger.cooldownMs
    );
    if (cooldownHit) {
      const ids = rows.map((row) => row.id);
      await repository.completeAlarmTriggers?.(ids, cooldownHit.runId);
      outcome.attached += ids.length;
      logger.log(
        `[AlarmTriggerConsumer] Attached ${ids.length} trigger(s) for spec_key=${specKey} to run ${cooldownHit.runId} (cooldown)`
      );
      continue;
    }
    launchRows.push(...rows);
    specKeys.push(specKey);
  }

  if (launchRows.length === 0) {
    return outcome;
  }

  const batchIds = launchRows.map((row) => row.id);

  // Final concurrency re-check: an investigation may have started during the debounce/claim/
  // cooldown lookups above. Queue, don't preempt — release back to pending for the next tick.
  if (launcher.isBusy()) {
    await repository.releaseAlarmTriggers?.(batchIds);
    outcome.released = batchIds.length;
    return { ...outcome, skipped: 'in-flight' };
  }

  const batch: AlarmTriggerBatch = { triggers: launchRows, specKeys };

  try {
    const result = await launcher.launch(batch);
    if (result.status === 'launched') {
      await repository.completeAlarmTriggers?.(batchIds, result.runId);
      outcome.launched = batchIds.length;
      logger.log(
        `[AlarmTriggerConsumer] Launched investigation ${result.runId} for ${specKeys.length} spec_key(s), ${batchIds.length} trigger(s)`
      );
    } else if (result.status === 'busy') {
      await repository.releaseAlarmTriggers?.(batchIds);
      outcome.released = batchIds.length;
    } else {
      // D7: launch failure is terminal (`error`), not requeued — avoids a retry storm against a
      // persistently failing investigation. The scheduled loop remains the backstop (design §10).
      await repository.failAlarmTriggers?.(batchIds);
      outcome.failed = batchIds.length;
      logger.error(`[AlarmTriggerConsumer] Launch failed: ${result.message}`);
    }
  } catch (error) {
    await repository.failAlarmTriggers?.(batchIds);
    outcome.failed = batchIds.length;
    logger.error('[AlarmTriggerConsumer] Launch threw:', error);
  }

  return outcome;
}

/**
 * Wraps `runAlarmTriggerConsumerOnce` on a `setInterval(pollMs)` with an overlap guard (a slow
 * tick is never re-entered) and returns a stop handle. A no-op when the feature is disabled —
 * no timer is scheduled, matching the "fully inert unless enabled" requirement.
 */
export function startAlarmTriggerConsumer(
  deps: AlarmTriggerConsumerDeps
): AlarmTriggerConsumerHandle {
  if (!deps.config.alarm.webhook.enabled) {
    return { stop: () => {} };
  }

  const logger = deps.logger ?? console;
  let stopped = false;
  let tickInFlight = false;

  const runTick = (): void => {
    if (stopped || tickInFlight) {
      return;
    }
    tickInFlight = true;
    void runAlarmTriggerConsumerOnce(deps)
      .catch((error) => {
        logger.error('[AlarmTriggerConsumer] Tick failed:', error);
      })
      .finally(() => {
        tickInFlight = false;
      });
  };

  runTick();
  const intervalId = setInterval(runTick, deps.config.alarm.trigger.pollMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(intervalId);
    },
  };
}
