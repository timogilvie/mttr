# Design: Alarm-triggered "investigate now" alongside scheduled healthchecks

Status: Draft · Owner: TBD · Last updated: 2026-07-02

## 1. Summary

Today the monitoring agent only investigates on a fixed cadence: the worker's
`setInterval` loop fetches the S3 health report every `MONITOR_INTERVAL_MS`
(15 min default) and skips entirely when the report content hash is unchanged. A
real incident can therefore sit undetected for up to a full interval.

This design adds a **low-latency, push-driven path** so a CloudWatch alarm can
initiate the Investigate loop within seconds, while the periodic healthcheck
remains the baseline and the durable backstop. The alarm enters the existing
pipeline by being synthesized into a *mandatory-style incident spec* (reusing
`src/report/mandatoryIncidents.ts`) and handed to the worker through a durable,
Postgres-backed trigger queue.

## 2. Background — current architecture

- **worker** (`src/orchestrator.ts`): single `setInterval` loop. Each `tick()`
  fetches the report from S3 (`HEALTH_REPORT_S3_URI`), hashes it, and skips when
  unchanged. On a changed report it runs
  Classify → Investigate → Decide → Verify → Mitigate(stub), reconciles
  observations, and sends Slack transition alerts. Overlap is prevented by the
  `classifyInFlight` / `investigateInFlight` booleans — a slow run skips the next
  tick rather than queuing.
- **web** (`src/web/api.ts`): Fastify service, read-only GET endpoints plus
  `/healthz`. No write/webhook routes exist yet.
- **Investigate loop** (`src/stages/investigate.ts`): bounded AWS-read-only LLM
  tool loop, budgeted by `INVESTIGATE_MAX_TOOL_*`. Currently only reachable
  *through* Classify, which requires a changed report.
- **Reports** are produced by an **external** system; this repo only consumes
  them from S3 and cannot regenerate one on demand.
- **Alarms → incidents already exists (pull path):** `extractActiveAlarmSpecs` /
  `enforceMandatoryIncidents` (`src/report/mandatoryIncidents.ts`) parse `ALARM`
  rows out of the report markdown into deterministic CRITICAL incidents, deduped
  by `specDedupeKey` / `incidentCoversSpec`.
- **Incident dedupe has three layers**, all of which any new incident must land
  in consistently: canonical observation keys (`canonicalObservationKey` /
  `reconcileObservations`), mandatory-spec dedupe (`specDedupeKey` /
  `incidentCoversSpec`), and dashboard read-side dedupe (`incidentDedupeKey`,
  `src/web/api.ts`).
- **State**: file or Postgres (`runs`, `incidents`, `incident_events`, `alerts`,
  `worker_heartbeats`; `src/db/migrations.ts`). Deploy is a long-lived
  docker-compose stack (worker + web + postgres) on EC2.

## 3. Goals / non-goals

**Goals**
- Investigation begins within seconds of a high-severity CloudWatch alarm.
- Keep the scheduled cadence as baseline and as the backstop if the push path fails.
- Reuse the existing pipeline, incident model, and all three dedupe layers — a
  push-born and a report-born alarm must converge to one incident.
- Idempotent, replay-safe ingestion; no duplicate or runaway investigations under
  flapping or alarm storms.

**Non-goals**
- No change to how reports are generated (external system).
- No new mutating AWS actions — the agent stays read-only during investigation.
- No autoscaling of the worker; concurrency stays single-flight for now.

## 4. Proposed architecture

Canonical path:

```
CloudWatch Alarm (ALARM state)
  → SNS topic (alarm action)
    → HTTPS subscription → POST /webhooks/cloudwatch/:token   [web / Fastify]
        1. verify SNS signature + path token
        2. handle SubscriptionConfirmation handshake
        3. idempotency check on SNS MessageId
        4. durably INSERT into alarm_triggers, return 200 fast
    → alarm_triggers table  [postgres]                        [hand-off boundary]
      → worker consumer: poll every ALARM_TRIGGER_POLL_MS (+ optional LISTEN/NOTIFY)
          5. drain + coalesce pending triggers into one batch
          6. severity gate + per-alarm cooldown
          7. respect investigateInFlight
          8. synthesize mandatory-style incident spec(s)
          9. runInvestigationFromTrigger() → Investigate → Decide → Verify
         10. reconcile through the 3 dedupe layers; run tagged trigger_source=alarm
```

**Why a Postgres trigger table for the web→worker hand-off.** The alarm lands on
the *web* process but the Investigate loop lives on the *worker*. A durable
`alarm_triggers` table is the lowest-friction fit for the current
worker+web+postgres deploy: it survives restarts (an in-memory queue or direct
HTTP call would drop alarms if the worker is mid-restart), it lets the web handler
return 200 immediately after a durable write (satisfying SNS delivery timeouts),
and it keeps the single-flight investigation guard authoritatively on the worker.
The worker polls on a short interval (default 5s — "within seconds"); Postgres
`LISTEN/NOTIFY` is an optional latency optimization layered on top, never the sole
mechanism (a disconnected worker misses NOTIFY, so the poll is the source of truth).

*Rejected alternatives:* (a) web calls the orchestrator over internal HTTP — no
durability, duplicates the in-flight guard, races on restart; (b) collapse web +
worker into one process — larger blast radius, breaks the current deploy topology;
(c) SQS instead of a Postgres table — adds infra with no benefit given Postgres is
already the state store.

## 5. Component design

### 5.1 Ingress — `POST /webhooks/cloudwatch/:token` (Fastify)
- **SubscriptionConfirmation**: on `Type: SubscriptionConfirmation`, verify then GET
  the `SubscribeURL` to confirm (gated by `ALARM_WEBHOOK_AUTOCONFIRM`).
- **Signature verification**: validate the SNS message signature against the
  `SigningCertURL` (host must be an `amazonaws.com` SNS cert host). Reject on
  failure. Independent of the path `:token` shared secret, which is a cheap first gate.
- **Idempotency**: dedupe on SNS `MessageId` via `processed_sns_messages`; a
  duplicate returns 200 without enqueueing.
- **Durable enqueue**: parse the CloudWatch alarm payload, insert one
  `alarm_triggers` row (status `pending`), return 200. All heavy work is deferred
  to the worker.

### 5.2 Alarm → incident spec synthesis (pure)
- New mapper: SNS CloudWatch alarm payload → the same incident-spec shape produced
  by `extractActiveAlarmSpecs`, reusing severity rules (task-health alarms →
  CRITICAL) and `specDedupeKey`. This guarantees push- and report-born alarms
  produce identical specs and therefore dedupe.
- Pure and unit-testable; no I/O.

### 5.3 Worker trigger consumer
- Polls `alarm_triggers` for `pending` rows every `ALARM_TRIGGER_POLL_MS`.
- **Drain + coalesce**: claims all pending rows in one pass (row-locking /
  `FOR UPDATE SKIP LOCKED`) and coalesces them — an alarm storm becomes one
  investigation over N synthesized specs, not N investigations.
- **Severity gate**: only alarms ≥ `ALARM_TRIGGER_MIN_SEVERITY` fire ASAP; lower
  severities are marked `deferred` and left for the scheduled tick.
- **Cooldown / flapping**: per-alarm-key cooldown `ALARM_TRIGGER_COOLDOWN_MS`; a
  repeat within the window attaches to the open incident instead of launching.
- **Concurrency**: respects `investigateInFlight`. If an investigation is already
  running, triggers stay `pending` and are drained on the next poll (coalesced with
  whatever else arrived) — queue, don't preempt.

### 5.4 Orchestrator out-of-band entry point
- New `runInvestigationFromTrigger(specs)`: builds a `ClassificationResult`-shaped
  payload from the synthesized specs (bypassing the LLM Classify stage) and drives
  the existing `runInvestigate → runDecide → runSelectedResponseStage` chain.
- Records a `run` with `trigger_source = 'alarm'`; reconciles through
  `reconcileObservations` and the mandatory-spec / canonical-key layers so an
  alarm-born incident merges with any report-born counterpart.

### 5.5 OK / recovery transitions
- On `OK`, do **not** launch a full investigation. Instead run a **lightweight
  verify pass** (the existing Verify stage, scoped to the recovering incident's
  checks) to confirm the recovery is real before recording it — this guards against
  a flapping alarm reporting OK while the underlying fault persists. On a confirmed
  verify, record a recovery `incident_event` and move the incident toward resolved
  (respecting existing transition rules in `src/state/transitions.ts`); on a failed
  verify, keep the incident open. `INSUFFICIENT_DATA` is logged and ignored for
  triggering (configurable later).

### 5.6 Provenance & observability
- Add `trigger_source` (`scheduled` | `alarm`) to `runs`; surface it in
  `/api/runs`, `/api/runs/:id`, and in the Slack alert body.
- Metrics/log counters: alarms received / signature-rejected / idempotent-dropped /
  severity-deferred / cooldown-attached / coalesced / investigations-launched.

## 6. Data model changes (migration)

- `alarm_triggers`: `id`, `sns_message_id`, `alarm_arn`, `alarm_name`,
  `new_state` (`ALARM|OK|INSUFFICIENT_DATA`), `state_change_time`, `severity`,
  `spec_key`, `payload jsonb`, `status` (`pending|claimed|done|deferred|error`),
  `received_at`, `claimed_at`, `processed_at`, `run_id` (fk, nullable).
- `processed_sns_messages`: `sns_message_id` (pk), `received_at` — ingest idempotency.
- `runs`: add `trigger_source text not null default 'scheduled'`.

## 7. Configuration (env, via `src/config.ts`)

| Var | Default | Purpose |
|---|---|---|
| `ALARM_WEBHOOK_ENABLED` | `false` | Master switch for the ingress route + consumer |
| `ALARM_WEBHOOK_PATH_TOKEN` | — | Shared secret in the route path |
| `ALARM_WEBHOOK_VERIFY_SIGNATURE` | `true` | Verify SNS message signatures |
| `ALARM_WEBHOOK_AUTOCONFIRM` | `true` | Auto-confirm SNS subscription |
| `ALARM_TRIGGER_MIN_SEVERITY` | `CRITICAL` | Minimum severity to trigger ASAP |
| `ALARM_TRIGGER_COOLDOWN_MS` | `600000` | Per-alarm anti-flap window |
| `ALARM_TRIGGER_POLL_MS` | `5000` | Worker consumer poll interval |
| `ALARM_TRIGGER_COALESCE_MS` | `2000` | Storm debounce before draining |

## 8. Case-handling matrix

| Case | Handling |
|---|---|
| ALARM transition | Synthesize spec → coalesce → investigate (if ≥ min severity) |
| OK transition | Lightweight verify pass to confirm recovery → record recovery + move toward resolved; no full investigation |
| INSUFFICIENT_DATA | Log, no trigger |
| Duplicate/open incident | Reconcile via all 3 dedupe layers; attach, don't duplicate |
| Flapping (ALARM↔OK) | Per-alarm cooldown window; attach within window |
| Alarm storm | Drain + coalesce into one investigation over N specs |
| Investigation in flight | Leave triggers pending; drain/coalesce next poll (no preempt) |
| Low severity | Mark `deferred`; scheduled tick handles it |
| SNS at-least-once / replay | Idempotent on `MessageId`; alarm identity = ARN + state-change-time |
| Out-of-order / stale delivery | Ignore a delivery older than the current incident's last state |
| Webhook down / worker busy | SNS retry + DLQ; scheduled loop is the backstop |

## 9. Security

- Two independent gates: path shared-secret token (cheap) **and** SNS signature
  verification (authoritative). Neither alone is sufficient.
- Subscription confirmation only auto-confirmed for the expected topic ARN.
- No secrets in tool arguments; AWS access remains read-only.

## 10. Failure modes & rollout

- **No alarm lost silently:** durable enqueue + SNS DLQ + the scheduled loop as
  backstop. If the worker is down, triggers accumulate as `pending` and drain on
  restart (bounded by cooldown/coalesce).
- **Rollout:** ship dark behind `ALARM_WEBHOOK_ENABLED=false`; deploy migration;
  stand up SNS topic + subscription + DLQ; enable in staging; wire CloudWatch alarm
  actions; enable in prod. Fully reversible by flipping the flag.

## 11. Decisions & open questions

**Decided**
- **OK → lightweight verify (not just close).** On an `OK` transition we run a
  scoped Verify pass to confirm the recovery before resolving the incident (§5.5),
  rather than closing blindly on the report.
- **SNS topic + alarm-action wiring lives in the infra repo, not here.** This repo
  owns only the webhook endpoint and the SNS subscription confirmation. The infra
  repo owns the SNS topic, the CloudWatch alarm→SNS actions, and the DLQ; T10 is a
  coordination ticket against that repo, not code in this one.

**Open**
1. `LISTEN/NOTIFY` in v1, or poll-only until latency proves insufficient?
2. Severity mapping source of truth — alarm name/namespace heuristics (reuse
   mandatory logic) vs. an explicit alarm→severity config map?

## 12. Implementation plan

Tracked as sub-issues of the epic **"Alarm-triggered investigate loop"** in the
MTTR project. Sequencing (→ = blocks):

- T1 DB migration (queue + idempotency + provenance) → T4, T5, T8
- T2 Config & env plumbing → T3, T4, T5
- T3 Alarm→spec synthesis → T6
- T4 Webhook ingress (handshake, signature, idempotent enqueue) → T9, T10
- T5 Worker trigger consumer (drain/coalesce/cooldown/concurrency) → T6, T9
- T6 Orchestrator out-of-band entry point → T7, T8, T9, T11
- T7 OK/recovery handling → T11
- T8 Provenance in API + Slack → T11
- T9 Observability + DLQ/backstop → T11
- T10 AWS infra (SNS topic, alarm actions, subscription, DLQ, IAM) → T11
- T11 Tests, docs, compose wiring, deploy
