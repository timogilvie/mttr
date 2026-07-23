# Hokusai Monitoring Agent

Five-stage monitoring agent that classifies and investigates incidents from CloudWatch health reports.

## Setup

```bash
pnpm install
cp .env.example .env
# Edit .env with your OPENROUTER_API_KEY
```

## Run

```bash
pnpm start
```

## Test

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

## Configuration

All configuration is via environment variables. See `.env.example` for the full list with defaults.

Required:
- `OPENROUTER_API_KEY`: OpenRouter API key for LLM access

Commonly tuned (with defaults):
- `OPENROUTER_MODEL` (`openai/gpt-4o-mini`): model for the Classify stage
- `INVESTIGATE_MODEL` (`openai/gpt-5.4`): model for the Investigate stage. **Must support tool/function calling.**
- `INVESTIGATE_MODEL_FALLBACK` (`anthropic/claude-3.5-sonnet`): used once per run if the primary model is unavailable or doesn't support tools
- `HEALTH_REPORT_S3_URI` (`s3://hokusai-health-reports-development/latest/development/report.md`)
- `AWS_REGION` (`us-east-1`)
- `MONITOR_INTERVAL_MS` (`900000`)
- `INCIDENT_SWEEP_ENABLED` (`true`), `INCIDENT_SWEEP_STALE_AFTER_MS` (`21600000`),
  `INCIDENT_SWEEP_MAX_INCIDENTS` (`3`): stale-incident re-verification, see below
- `STATE_BACKEND` (`file`): use `postgres` on the continuous-monitoring server
- `DATABASE_URL`: required when `STATE_BACKEND=postgres`
- `POOLED_DATABASE_URL`: optional runtime pooler URL; when set, worker/web connections use this
  instead of `DATABASE_URL`

The Investigate stage's tool loop and rate-limit behaviour are bounded by several budgets
(`INVESTIGATE_MAX_TOOL_ITERATIONS`, `INVESTIGATE_MAX_TOOL_CALLS`, `INVESTIGATE_LLM_TIMEOUT_MS`,
`INVESTIGATE_CONSECUTIVE_FAILURE_LIMIT`, `TOOL_*`, `OPENROUTER_*`, `AWS_MAX_ATTEMPTS`). When a
draft investigation defers tool-executable root-cause checks while
`requires_more_evidence_before_mitigation=true`, Investigate may run one bounded closure pass
controlled by `INVESTIGATE_CLOSURE_ENABLED`, `INVESTIGATE_CLOSURE_MAX_TOOL_ITERATIONS`, and
`INVESTIGATE_CLOSURE_MAX_TOOL_CALLS`. See
`.env.example` for all of them.

## Database migrations

File state remains the default for local development. For the server deployment, set
`STATE_BACKEND=postgres` and `DATABASE_URL` to the direct database URL, then run:

```bash
pnpm db:migrate
```

For the long-running worker/web runtime, also set `POOLED_DATABASE_URL` when your provider offers a
pooler connection string. The migration command uses `DATABASE_URL`; runtime pools prefer
`POOLED_DATABASE_URL` and fall back to `DATABASE_URL`.

The first migration creates the continuous-monitoring foundation tables:
`report_states`, `observation_states`, `runs`, `incidents`, `incident_events`, `alerts`, and
`worker_heartbeats`.

Slack alert delivery is disabled unless `SLACK_WEBHOOK_URL` is set. When enabled, transition
alerts are sent to that webhook and successful sends are stored in `alerts` using the configured
`SLACK_ALERT_CHANNEL` for dedupe keys.

Start the API server with:

```bash
pnpm start:web
```

It listens on `WEB_HOST` / `WEB_PORT` and exposes read-only JSON endpoints for `/api/status`,
`/api/runs`, `/api/runs/:id`, `/api/incidents`, `/api/incidents/:id`, `/api/alerts`, and
`/api/settings`, plus `/api/incidents/:id/brief`, which returns a markdown handoff document
(current status, closure gate, ranked likely causes with confidence, unresolved evidence
requirements and the tool call that would resolve each, verification checks, and the timeline).
The incident page's "Copy handoff" button serves the same document.

## Incident identity and lifecycle

**Identity.** Incidents are keyed on a *signal key* — a name for the monitored signal, not for the
occurrence (`src/state/signalKey.ts`). Classify emits a `signal_key` per incident and finding, and
report-derived incidents get a deterministic one that overrides it. This is what stops a single
condition from re-entering as a new incident every time the model rewords its title. When no
signal key is available the agent falls back to the previous title-based hash.

**Lifecycle.** An observation disappearing from the health report moves its incident to
`absent_unverified`, not `resolved`: the report generator going quiet is not evidence that
anything was fixed. Those incidents are listed separately on the dashboard and stay eligible for
the sweep until a Verify pass proves recovery (`resolved`) or proves they were never incidents
(`closed`).

**Sweep.** Classify only runs when the report's content hash changes. On the other ticks the agent
re-verifies open incidents that have had no activity for `INCIDENT_SWEEP_STALE_AFTER_MS`, at most
`INCIDENT_SWEEP_MAX_INCIDENTS` per tick. This is what advances an incident whose report text is
stable. It requires `STATE_BACKEND=postgres`; the file backend has no incident table to sweep.

A swept incident always records a Verify event, so its staleness clock resets and it will not be
swept again until the threshold elapses. How decisively the sweep closes an incident depends on
what Verify can check: it builds checks from alarm names scraped out of the stored decision's
`evidence_to_pass` plus ECS/ALB checks for the affected service. Incidents whose signal is a plain
CloudWatch metric with no alarm give Verify little to check, so they tend to land on
`VERIFIED_OBSERVABILITY_ISSUE` rather than a confident recovery. Broadening the Verify stage's
check vocabulary is the follow-up that would make those closures precise.

## Docker Compose deployment

The first server deployment uses one shared image for `mttr-worker`, `mttr-web`, and migrations.
Copy `.env.compose.example` to `.env.compose`, fill in secrets, then run:

```bash
docker compose --env-file .env.compose up -d postgres
docker compose --env-file .env.compose run --rm migrate
docker compose --env-file .env.compose up -d web worker
```

The Compose stack contains:

- `postgres`: local persistent Postgres volume for single-server deployments.
- `migrate`: one-shot `pnpm db:migrate`.
- `worker`: long-running 15-minute monitor loop.
- `web`: Fastify API plus the built Vite dashboard on `WEB_PORT`.

Run the local Compose smoke check with:

```bash
COMPOSE_ENV_FILE=.env.compose pnpm smoke:compose
```

The smoke check validates Compose config, builds the shared image, runs migrations, verifies
`/healthz`, and starts the worker in `MTTR_WORKER_SMOKE=1` mode so it validates config without
fetching a report or sending alerts.

For the `status.hokus.ai` EC2 deployment with Neon and Caddy-managed HTTPS, use
[docs/ec2-deploy.md](docs/ec2-deploy.md) and `docker-compose.ec2.yml`.

## AWS access (read-only)

The agent reads from AWS, never writes. Credentials are resolved from the standard AWS provider
chain (environment, shared config, or instance/task role) — they are never passed through tool
arguments.

Required permissions:

- **Classify** reads the health report from S3 (`s3:GetObject` on the report bucket).
- **Investigate** gathers evidence from CloudWatch Logs Insights and CloudWatch
  metrics/alarms, plus read-only AWS runtime/change metadata for Lambda,
  EventBridge, ECS, and CloudTrail.

Minimum read-only IAM policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "HealthReport",
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::hokusai-health-reports-development/*"
    },
    {
      "Sid": "InvestigateLogs",
      "Effect": "Allow",
      "Action": [
        "logs:StartQuery",
        "logs:GetQueryResults",
        "logs:StopQuery",
        "logs:FilterLogEvents",
        "logs:DescribeLogGroups"
      ],
      "Resource": "*"
    },
    {
      "Sid": "InvestigateMetricsAndAlarms",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:GetMetricStatistics",
        "cloudwatch:GetMetricData",
        "cloudwatch:ListMetrics",
        "cloudwatch:DescribeAlarms",
        "cloudwatch:DescribeAlarmHistory"
      ],
      "Resource": "*"
    },
    {
      "Sid": "InvestigateRuntimeAndChanges",
      "Effect": "Allow",
      "Action": [
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:ListAliases",
        "lambda:ListTags",
        "lambda:ListVersionsByFunction",
        "ecr:BatchGetImage",
        "ecr:DescribeImages",
        "ecr:GetDownloadUrlForLayer",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:DescribeStacks",
        "events:DescribeRule",
        "events:ListTargetsByRule",
        "cloudtrail:LookupEvents",
        "elasticloadbalancing:DescribeLoadBalancers",
        "elasticloadbalancing:DescribeLoadBalancerAttributes",
        "ecs:ListClusters",
        "ecs:ListServices",
        "ecs:DescribeServices",
        "ecs:ListTasks",
        "ecs:DescribeTasks",
        "ecs:DescribeTaskDefinition"
      ],
      "Resource": "*"
    }
  ]
}
```

If ALB access-log investigation is enabled for your report bucket, also allow `s3:ListBucket` on
that bucket and `s3:GetObject` on the relevant access-log prefixes.

No infrastructure write/mutate actions are required or used. The only non-read-style AWS actions
are CloudWatch Logs Insights query-control actions (`logs:StartQuery` and `logs:StopQuery`), which
create/stop a diagnostic query but do not mutate monitored services. Scope the `Resource` for the
CloudWatch statements down to specific log groups / namespaces if your environment supports it. If
these permissions are missing, the Investigate tools return the error as evidence ("missing
telemetry") and the stage degrades to a triage / data-request result rather than failing.

## Architecture

### Stages

1. **Classify** (implemented): Analyzes the health report and produces structured incident
   classifications and findings.
2. **Investigate** (implemented): Takes the Classify output and investigates each item using a
   bounded, read-only agentic tool loop (CloudWatch Logs Insights + CloudWatch
   metrics/alarms over OpenRouter), producing a validated investigation with likely causes,
   evidence, data requests, and a per-item "ready for mitigation" signal. It never remediates.
3. **Decide** (implemented): Deterministically turns investigation output into a response
   disposition: mitigate, verify, continue investigation, close/downgrade, or open an
   observability follow-up.
4. **Mitigate** (stub): Future mitigation actions.
5. **Restore** (stub): Future service restoration.
6. **Verify** (implemented): Read-only current-state checks for decisions that need
   validation before closure or mitigation. The first version checks current alarm state,
   ECS service health/events, and ALB error evidence where the decision handoff asks for it.

### Investigate tool loop — bounded by design

The Investigate stage drives read-only tools through a multi-turn loop that cannot run away:

- per-run iteration and global tool-call budgets, then a forced final answer with no tools;
- at most one smaller root-cause closure pass when the first valid JSON still defers
  executable evidence-gathering steps;
- a whole-loop timeout (`INVESTIGATE_LLM_TIMEOUT_MS`);
- a circuit breaker on consecutive failing tool turns;
- 429/5xx backoff on OpenRouter and adaptive throttling-retry on AWS clients;
- bounded query windows and truncated tool results.

The stage validates the model's JSON output against a strict schema, with one repair retry and
a safe fallback, so malformed output never reaches downstream stages.

### Non-blocking Orchestrator

The orchestrator runs on a loop without blocking on long-running stage execution. After a
successful Classify with actionable incidents or findings, it chains into Investigate. In-flight
guards prevent overlapping Classify and Investigate runs; a slow stage delays the next tick
rather than stacking.

## Continuous Monitoring Architecture

The current codebase is already shaped like the worker process: `src/index.ts` starts one
long-running `Orchestrator`, and `src/orchestrator.ts` runs the read-only Classify →
Investigate → Decide → Verify/Mitigate flow on `MONITOR_INTERVAL_MS`. The production default is
15 minutes (`900000` ms). The existing in-flight guards should remain the first concurrency
boundary; a slow run should skip the next tick rather than enqueue duplicate work.

### Current state to preserve

- The agent is read-only against AWS. Tools read S3 health reports, CloudWatch logs/metrics/
  alarms, ECS, Lambda, EventBridge, CloudTrail, ALB access logs, CloudFormation/ECR metadata,
  and contract state. Keep this boundary until the UI and alert lifecycle are reliable.
- `.mttr-state.json` currently stores the last processed report hash plus active/resolved
  observation state. A database-backed version should replace this state store instead of
  introducing a second incident tracker.
- `IncidentDecision` and `VerificationResult` are the right downstream contracts for alerting:
  alert after Decide and update/close after Verify when that stage runs.
- Mitigate is still a stub. Treat `overall_next_stage=Mitigate` as "ready for mitigation" for
  alerting and UI purposes, not as permission to mutate infrastructure.

### Target deployment

Run three services on one server first:

- `mttr-worker`: the existing Node/TypeScript process, packaged as a long-running worker.
- `mttr-web`: a separate API/UI process in the same repo.
- `postgres`: persistent state for runs, incidents, evidence, decisions, verification, and alerts.

Docker Compose is the right first deployment target. Move to ECS later only when the single-server
operational model is proven.

### Persistence model

Prefer Postgres for the first server deployment. SQLite is acceptable only for a truly
single-host prototype, but Postgres maps better to row locks, alert dedupe, future multi-worker
leases, and a web UI reading while the worker writes.

Initial tables:

- `runs`: `id`, `started_at`, `finished_at`, `status`, `health_report_s3_uri`, `report_hash`,
  `summary`, `overall_severity`, `raw_classification_json`, `raw_investigation_json`,
  `raw_decision_json`, `raw_verification_json`, `error_message`.
- `incidents`: `incident_id`, `title`, `service`, `severity`, `state`, `opened_at`, `closed_at`,
  `current_disposition`, `current_next_stage`, `current_decision_json`, `last_run_id`.
- `incident_events`: `id`, `incident_id`, `run_id`, `stage`, `message`, `severity`,
  `evidence_json`, `created_at`.
- `alerts`: `id`, `incident_id`, `run_id`, `channel`, `sent_at`, `dedupe_key`, `payload_json`.

Use stable incident keys from the existing reconciliation logic for findings, because findings
do not have model-provided `incident_id`s. Keep the report hash skip behavior by storing the last
processed hash per `health_report_s3_uri`.

### Alerting boundary

Keep detection and alert delivery separate. After Decide, compare the persisted previous incident
state to the new decision and emit an `IncidentStateChanged` domain event. Slack is the first
channel; email can be added behind the same event later.

Alert on:

- new active incident or actionable finding;
- severity increase;
- disposition changes to `MITIGATE` / `overall_next_stage=Mitigate` ("ready for mitigation");
- verification confirms active impact;
- recovered, transient, non-incident, or closed state.

Do not alert on:

- same report hash;
- recurring observation with unchanged signature/severity;
- same incident state and same decision on a later 15-minute run.

Use `alerts.dedupe_key` in the form
`channel:incident_id:transition_type:severity:disposition` so repeated runs do not spam Slack.
The Slack sender records the alert only after Slack returns success; retryable failures such as
HTTP 429/5xx leave no alert row, so a later run can retry.

### Web UI

Use Fastify API + Vite/React UI for the first version. This repo is currently a TypeScript
service, not a Next.js app, so Fastify/Vite keeps the worker and web server explicit while still
sharing types.

The current `/` dashboard is bundled by `pnpm build` into `dist/web` and served by `pnpm start:web`.
It shows green/yellow/red status, stale worker/report warnings, the last run, open incidents, and
recent transition events from the persisted state API.

Pages:

- `/`: current status, last run, worker heartbeat, open incidents, and recent transitions.
- `/incidents/:id`: timeline from `incident_events`, classification, investigation evidence,
  current decision, verification checks, and alert history.
- `/runs/:id`: raw stage outputs, report hash, timestamps, errors, and compact tool trace/evidence.
- `/settings`: alert channel config, monitored health report URI, thresholds, and read-only AWS
  account/region display.

### Queue decision

Do not add BullMQ or SQS yet. For one environment and one 15-minute worker, Postgres row locks plus
the existing in-flight guards are enough. Add a queue only when monitoring multiple environments,
running per-incident work in parallel, or needing retryable alert delivery independent of worker
runs.

## Operations runbook

### Required server environment

Set these values in `.env.compose` for the Docker Compose deployment:

- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`: local Postgres credentials.
- `OPENROUTER_API_KEY`: required by worker, web config loading, and migrations.
- `HEALTH_REPORT_S3_URI`: report object watched by the worker.
- `AWS_REGION`: region for AWS reads.
- `MONITOR_INTERVAL_MS`: defaults to `900000`; keep this at 15 minutes for v1.
- `WEB_PORT`: host port for the dashboard/API.
- `SLACK_WEBHOOK_URL`: optional; when empty, alerts are skipped but transition events still persist.
- `SLACK_ALERT_CHANNEL`: logical channel name used in alert dedupe keys.
- `AWS_CONFIG_DIR`: host AWS config path mounted read-only into the worker container.

For Neon or another managed Postgres instead of the Compose `postgres` service, run migrations with
the direct `DATABASE_URL`, set `STATE_BACKEND=postgres`, and use the provider pooler as
`POOLED_DATABASE_URL` for worker/web runtime connections. Keep `DATABASE_SSL=true` when the
provider requires TLS.

### Slack setup

Create a Slack incoming webhook for the target channel and set `SLACK_WEBHOOK_URL`. Alerts are sent
only for alertable transition events: new incident, severity increase, ready for mitigation,
verified active, recovered, and closed. Sent alerts are persisted in `alerts` with dedupe keys in
the form `channel:incident_id:transition_type:severity:disposition`, so a 15-minute recurring run
does not spam the same alert.

If Slack returns HTTP 429 or 5xx, the send is treated as retryable and no alert row is written. A
later run can retry because the dedupe key remains unsent.

### Backup and restore

For local Compose Postgres, back up before upgrades:

```bash
docker compose --env-file .env.compose exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > mttr-backup.sql
```

Restore into an empty database:

```bash
docker compose --env-file .env.compose exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < mttr-backup.sql
```

For Neon, use Neon point-in-time restore or branch-based recovery for production data. Use
`pnpm db:migrate` against the restored direct database URL before starting worker/web.

### Troubleshooting

- **Dashboard shows stale worker**: check `docker compose ps worker`, worker logs, and the
  `worker_heartbeats` table. The worker updates heartbeat when a run starts.
- **Dashboard shows stale report**: confirm the worker can read `HEALTH_REPORT_S3_URI` and that
  `runs.started_at` is updating. Same report hashes still produce skipped runs.
- **Failed run**: open `/runs/:id` and inspect `errorMessage` plus raw stage output. Common causes
  are missing S3/IAM access, OpenRouter/API errors, or invalid DB connectivity.
- **No Slack alert**: verify `SLACK_WEBHOOK_URL`, inspect `incident_events` for alertable
  `transition_type`, and check `alerts` for an existing dedupe key.
- **Repeated alert concern**: alerts dedupe on `alerts.dedupe_key`. Identical recurring decisions
  produce non-alertable `unchanged` transition events.
- **Migration failure**: use the direct database URL, not the pooler URL, and confirm
  `OPENROUTER_API_KEY` is present because config loading validates required env vars.

### First deployment checklist

1. Create `.env.compose` from `.env.compose.example`.
2. Confirm read-only AWS credentials are available on the server and mounted via `AWS_CONFIG_DIR`.
3. Set `OPENROUTER_API_KEY`, `HEALTH_REPORT_S3_URI`, and optional Slack settings.
4. Run `COMPOSE_ENV_FILE=.env.compose pnpm smoke:compose`.
5. Start the stack with `docker compose --env-file .env.compose up -d web worker`.
6. Open `/` and confirm worker/report stale state clears after the first run starts.
7. Confirm `/api/status`, `/api/runs`, and `/api/incidents` return JSON.
8. Watch the first worker run logs and verify a row appears in `runs`.

Use [docs/release-checklist.md](docs/release-checklist.md) for the full MVP release checklist,
including scenario checks for healthy, new incident, unchanged recurrence, escalation, mitigation,
recovery, failed run, alert dedupe, and the read-only AWS boundary.

### Rollback checklist

1. Stop worker first: `docker compose --env-file .env.compose stop worker`.
2. Keep web running if you need to inspect the last known state.
3. Restore the previous image or git revision and rebuild with `docker compose build`.
4. If a migration changed schema, restore from the latest Postgres/Neon backup before restarting.
5. Start `web`, verify `/healthz`, then start `worker`.

### Queue policy

Do not add BullMQ, Redis, or SQS for v1. The single worker, 15-minute cadence, persisted run state,
alert dedupe keys, and in-flight guards are enough for one environment. Add a queue only when you
need multiple monitored environments, parallel per-incident workers, or independently retryable
alert delivery outside the monitor run lifecycle.
