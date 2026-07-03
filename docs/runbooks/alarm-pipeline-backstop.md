# Runbook: Alarm pipeline observability, DLQ, and scheduled-loop backstop

Status: Active · Last updated: 2026-07-03

See [`docs/alarm-triggered-investigation.md`](../alarm-triggered-investigation.md) §5.6/§10 for
the full design. This note is the operator-facing companion: what the pipeline emits, and what
to do when it stalls.

## 1. Pipeline stages and metrics

Every stage the alarm path can take emits a structured counter (or, for launch, also a latency
measurement) through [`src/util/metrics.ts`](../../src/util/metrics.ts). Emission never throws —
a broken/misconfigured logger cannot take down ingress or the consumer — so an absence of a
metric means the stage genuinely didn't run, not that logging failed silently.

| Metric | Emitted from | Meaning |
|---|---|---|
| `alarm_pipeline.alarms_received` | `src/web/api.ts` (webhook) | A new `ALARM` CloudWatch notification was durably enqueued into `alarm_triggers`. |
| `alarm_pipeline.signature_rejected` | `src/web/api.ts` (webhook) | SNS message signature verification failed; the request was rejected before touching the database. |
| `alarm_pipeline.idempotent_dropped` | `src/web/api.ts` (webhook) | An SNS message with an `sns_message_id` we've already processed (any `new_state`) arrived again — expected under SNS's at-least-once delivery, not an error. |
| `alarm_pipeline.severity_deferred` | `src/alarm/triggerConsumer.ts` | A claimed row was marked `deferred`: below `ALARM_TRIGGER_MIN_SEVERITY`, or missing `severity`/`spec_key` (fail-safe — never fail-open). Left for the scheduled tick, not investigated immediately. |
| `alarm_pipeline.cooldown_attached` | `src/alarm/triggerConsumer.ts` | A row's `spec_key` already has a launched run within `ALARM_TRIGGER_COOLDOWN_MS`; the row was attached to that run instead of starting a new investigation (anti-flap). |
| `alarm_pipeline.coalesced` | `src/alarm/triggerConsumer.ts` | More than one eligible row shared a `spec_key` in the same drain — a storm collapsed into one downstream action (launch or cooldown-attach). `coalesced_count` is the number of *extra* rows folded in (group size − 1). Emitted once per group, not once per row, since the point of coalescing is the group formation itself. |
| `alarm_pipeline.investigations_launched` | `src/alarm/triggerConsumer.ts` | A row's batch successfully launched (or joined) an investigation and was marked `done`. Emitted once per row. |
| `alarm_pipeline.trigger_to_investigation_ms` | `src/alarm/triggerConsumer.ts` | Latency from `alarm_triggers.received_at` (durable-enqueue time) to investigation launch, one measurement per launched row. Non-finite or negative values are dropped rather than emitted — a fabricated latency is worse than a missing data point. |

Fields present depending on context: `alarm_name`, `trigger_id`, `sns_message_id`, `spec_key`,
`coalesced_count`, `value_ms`. Payloads never include the raw SNS signature, full SNS envelope,
or other secrets.

**Where these land:** ingress (`src/web/api.ts`) emits through Fastify's `request.log` (structured
JSON when a real logger is configured); the consumer (`src/alarm/triggerConsumer.ts`) emits
through its injected `logger` (defaults to `console`, one JSON line per event via `.log(...)`).
Point your log aggregator's search/alerting at the `metric` field.

**What does *not* get counted as `alarms_received`:** wrong path token (404, rejected before SNS
parsing), malformed/unsupported SNS envelope, wrong topic ARN, and non-`ALARM` state-change
notifications (`OK`/`INSUFFICIENT_DATA`) that are structurally valid but not a fresh alarm. These
are intentionally silent from a metrics perspective — they're either noise/attack traffic or an
explicitly different case (`OK` recovery is a separate, not-yet-implemented flow; see design doc
§5.5/§11).

## 2. The backstop story

The design's core promise (design doc §10): **no alarm is lost silently.** Three independent
layers back each other up:

1. **Durable enqueue before heavy work.** The webhook handler's only job is to verify the
   request and durably `INSERT` into `alarm_triggers` (via `enqueueAlarmTriggerOnce`, transactional
   with the `processed_sns_messages` idempotency record) before returning `200`. The row exists
   in Postgres the instant the webhook acknowledges — nothing downstream needs to succeed for the
   alarm to be captured.
2. **SNS retry + DLQ (ingress-side safety net, infra-owned).** If the webhook is down, slow, or
   returns a non-2xx, SNS retries delivery on its own backoff schedule and, after exhausting
   retries, routes the notification to a dead-letter queue instead of dropping it. **This repo
   does not provision the SNS topic, subscription, or DLQ** — that's owned by the infra repo (see
   design doc §11, "SNS topic + alarm-action wiring lives in the infra repo, not here"; tracked as
   a coordination ticket, not code here). What this repo *does* own: the webhook returns `200`
   only once the trigger is durably persisted, so SNS's automatic retry-on-failure only fires when
   we genuinely failed to enqueue — it isn't fighting against a lying success response.
3. **Scheduled loop (processing-side safety net, this repo).** `runAlarmTriggerConsumerOnce`
   (`src/alarm/triggerConsumer.ts`) polls `alarm_triggers` every `ALARM_TRIGGER_POLL_MS`
   independent of the webhook. If the consumer process restarts, or a tick fails outright (see
   `startAlarmTriggerConsumer`'s per-tick `catch`), unprocessed rows simply stay `pending` in
   Postgres and are picked up by the very next tick — nothing needs to be replayed by hand. Rows
   stranded in `claimed` by a crash mid-launch self-heal via `reclaimStaleClaimedTriggers` once
   `ALARM_TRIGGER_POLL_MS * 3` (or the coalesce window, whichever is larger) has passed.

Net effect: the webhook path is a **latency optimization**, not a dependency. Worst case (webhook
totally down, SNS retries exhausted) an operator still needs the periodic full-report healthcheck
(`MONITOR_INTERVAL_MS`) as the outermost backstop, per the design's non-goals — this pipeline's job
is only to make sure a durably-enqueued trigger is never silently stuck.

## 3. Detecting a stuck consumer

The failure mode this backstop can't self-heal from: rows sitting `pending` while the consumer
process itself is dead, wedged, or misconfigured (e.g. `ALARM_WEBHOOK_ENABLED=false`, which makes
`runAlarmTriggerConsumerOnce` a no-op). The signal is **aging pending rows**: the count of pending
alarm/insufficient-data triggers, and how old the oldest one is.

`AgentStateRepository.getAgingPendingAlarmTriggers(olderThanMs)` (Postgres-backed; a no-op
returning zeros on the file backend) returns:

```ts
{ count: number; oldestAgeMs: number | null; oldestReceivedAt: string | null }
```

It counts rows where `status = 'pending' AND new_state IN ('ALARM', 'INSUFFICIENT_DATA') AND
received_at < now() - olderThanMs`. **`OK`-state rows are deliberately excluded** — those are left
`pending` forever pending the not-yet-implemented T7 OK/recovery flow (design doc §5.5), so they
are not consumer backlog and would produce false positives if counted.

Equivalent manual query for direct inspection:

```sql
SELECT count(*)::text AS count, min(received_at) AS oldest_received_at
FROM alarm_triggers
WHERE status = 'pending'
  AND new_state IN ('ALARM', 'INSUFFICIENT_DATA')
  AND received_at < now() - interval '5 minutes';
```

**How to use it:** poll this on a threshold meaningfully larger than
`ALARM_TRIGGER_POLL_MS + ALARM_TRIGGER_COALESCE_MS` (a healthy consumer drains within roughly that
window). A non-zero `count` with a growing `oldestAgeMs` across successive checks means the
consumer has stopped draining — check:

- Is the worker process (`startAlarmTriggerConsumer`) actually running?
- Is `config.alarm.webhook.enabled` true in that process's environment?
- Is the launcher permanently `isBusy()` (an investigation stuck in flight)?
- Are `claimPendingAlarmTriggers`/`reclaimStaleClaimedTriggers` erroring against Postgres (check
  logs for `[AlarmTriggerConsumer] Tick failed:`)?

This method is read-only and additive — no schema or migration change was required to add it. It
is not yet wired into `/api/status` or alerting; that's a natural next step once this signal proves
useful operationally, but is out of scope for this task.

## 4. What's implemented here vs. infra provisioning

| Piece | Owner |
|---|---|
| Webhook signature/topic verification, durable enqueue, idempotency | This repo (`src/web/api.ts`, `src/state/repository.ts`) |
| Trigger consumer: coalesce, severity gate, cooldown, launch, reclaim | This repo (`src/alarm/triggerConsumer.ts`) |
| Counters/logs and trigger-to-investigation latency | This repo (`src/util/metrics.ts`) |
| Aging-pending query for stuck-consumer detection | This repo (`src/state/repository.ts`) |
| SNS topic, CloudWatch alarm→SNS actions, SNS subscription, DLQ | Infra repo (design doc §11) |
| Alerting/paging on the aging-pending signal | Not yet built (see §3 above) |
