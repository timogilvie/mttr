/**
 * Thin instrumentation adapter for the alarm pipeline (design doc §5.6/§10).
 *
 * The repo has no shared logger: ingress uses Fastify's `request.log` (a pino-like logger
 * exposing `.info`/`.warn`/`.error` and no `.log`), and the trigger consumer uses an
 * injected console-like logger (`.log`/`.warn`/`.error`, defaulting to the global `console`).
 * `MetricSink` is intentionally structural over both, and `emit()` discriminates on the
 * presence of `.log` — call sites never need to adapt their logger. Emission never throws;
 * instrumentation must not be able to break the alarm hot path it observes.
 */

export type JsonPrimitive = string | number | boolean | null | undefined;

export interface MetricFields {
  alarm_name?: JsonPrimitive;
  trigger_id?: JsonPrimitive;
  sns_message_id?: JsonPrimitive;
  spec_key?: JsonPrimitive;
  [key: string]: JsonPrimitive;
}

export interface MetricSink {
  info?: (payload: Record<string, unknown>, message?: string) => void;
  log?: (message: string) => void;
}

/** Stable counter metric names. Call sites must use one of these, never a raw string. */
export const ALARM_PIPELINE_COUNTER_METRICS = {
  ALARMS_RECEIVED: 'alarm_pipeline.alarms_received',
  SIGNATURE_REJECTED: 'alarm_pipeline.signature_rejected',
  IDEMPOTENT_DROPPED: 'alarm_pipeline.idempotent_dropped',
  SEVERITY_DEFERRED: 'alarm_pipeline.severity_deferred',
  COOLDOWN_ATTACHED: 'alarm_pipeline.cooldown_attached',
  COALESCED: 'alarm_pipeline.coalesced',
  INVESTIGATIONS_LAUNCHED: 'alarm_pipeline.investigations_launched',
  RECOVERY_VERIFY_ATTEMPTED: 'alarm_pipeline.recovery_verify_attempted',
  RECOVERY_VERIFY_CONFIRMED: 'alarm_pipeline.recovery_verify_confirmed',
  RECOVERY_VERIFY_FAILED: 'alarm_pipeline.recovery_verify_failed',
  RECOVERY_VERIFY_ERROR: 'alarm_pipeline.recovery_verify_error',
  RECOVERY_NO_OPEN_INCIDENT: 'alarm_pipeline.recovery_no_open_incident',
  INSUFFICIENT_DATA_IGNORED: 'alarm_pipeline.insufficient_data_ignored',
} as const;

export type AlarmPipelineCounterMetric =
  (typeof ALARM_PIPELINE_COUNTER_METRICS)[keyof typeof ALARM_PIPELINE_COUNTER_METRICS];

/** Trigger-to-investigation latency, measured from `alarm_triggers.received_at`. */
export const ALARM_PIPELINE_LATENCY_METRIC = 'alarm_pipeline.trigger_to_investigation_ms';

function emit(sink: MetricSink | undefined, payload: Record<string, unknown>): void {
  if (!sink) {
    return;
  }
  try {
    // Discriminate console-style (has `.log`) from pino-style (has `.info` only). `console.info`
    // is a documented alias of `console.log` that formats args via util.inspect — not a single
    // JSON line — so the presence of `.log` is what tells us we're looking at a console-like
    // sink and should emit `JSON.stringify(payload)` per the runbook. Only when `.log` is
    // absent (Fastify's `request.log`, a bare pino instance) do we route the payload+message
    // pair to `.info` for a structured emit.
    if (typeof sink.log === 'function') {
      sink.log(JSON.stringify(payload));
      return;
    }
    if (typeof sink.info === 'function') {
      sink.info(payload, String(payload['metric']));
    }
  } catch {
    // Never let a broken/throwing logger take down the alarm ingress or consumer path.
  }
}

/** Emits a stable counter event. Swallows all sink errors — never throws. */
export function emitCounter(
  sink: MetricSink | undefined,
  metric: AlarmPipelineCounterMetric,
  fields: MetricFields = {}
): void {
  emit(sink, { metric, ...fields });
}

/**
 * Emits a latency measurement in milliseconds. Non-finite or negative values are dropped
 * (clock skew / bad input should never emit a nonsensical latency) rather than normalized,
 * since a fabricated value would be more misleading than a missing data point.
 */
export function emitTiming(
  sink: MetricSink | undefined,
  metric: string,
  ms: number,
  fields: MetricFields = {}
): void {
  if (!Number.isFinite(ms) || ms < 0) {
    return;
  }
  emit(sink, { metric, value_ms: Math.round(ms), ...fields });
}
