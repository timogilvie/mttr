# Server Monitor MVP Release Checklist

Use this checklist before turning on continuous monitoring on a server.

## Preflight

1. Confirm `DATABASE_URL`, `POOLED_DATABASE_URL`, and `DATABASE_SSL=true` point at the Neon database.
2. Confirm `OPENROUTER_API_KEY`, `HEALTH_REPORT_S3_URI`, `AWS_REGION`, and read-only AWS credentials are present.
3. Confirm `MONITOR_INTERVAL_MS=900000` unless you are intentionally running a shorter smoke cadence.
4. Confirm `SLACK_WEBHOOK_URL` is set for the target channel, or intentionally leave Slack disabled.
5. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`.

## End-To-End Smoke

1. Run migrations with the direct database URL: `pnpm migrate:up`.
2. Start the web API and confirm `/healthz` returns `ok`.
3. Start one worker process and confirm it writes a heartbeat row.
4. Confirm the first successful run writes `runs`, linked `incidents`, `incident_events`, and alert records when transitions are alertable.
5. Refresh `/`, `/incidents/:id`, and `/runs/:id` and confirm they show the same persisted state.

## Scenario Checks

1. Healthy report: persists a successful run, dashboard stays green, no alert is sent.
2. New incident: creates an open incident, writes a `new_incident` event, sends one Slack alert.
3. Recurring unchanged incident: records the run without stacking work or sending another Slack alert.
4. Severity escalation: updates incident severity, writes `severity_increased`, sends one Slack alert.
5. Ready for mitigation: writes `ready_for_mitigation`, sends one Slack alert.
6. Recovered or closed: writes `recovered` or `closed`, closes the incident, sends one Slack alert.
7. Failed run: persists `runs.status=error`, leaves previous incident state readable, and exposes the error on `/runs/:id`.

## Read-Only Boundary

1. AWS IAM policy should contain only read, list, describe, lookup, and diagnostic CloudWatch Logs query-control permissions.
2. `logs:StartQuery` and `logs:StopQuery` are allowed only to run and stop Logs Insights queries.
3. Do not add AWS create, update, delete, invoke, run, stop, tag, or scaling permissions for the MVP.

## Deploy

1. Stop any local worker so only one server worker runs.
2. Build and start Compose: `docker compose --env-file .env.compose up -d postgres migrate web worker`.
3. Check `docker compose ps`, `docker compose logs worker`, and `docker compose logs web`.
4. Open the dashboard and confirm stale worker/report states clear after the first run starts.
5. Watch the first full 15-minute cadence and confirm repeated ticks do not stack or spam Slack.

## Rollback

1. Stop `worker` first.
2. Keep `web` up if you need to inspect the last persisted state.
3. Restore the previous image or git revision.
4. Restore the latest Neon backup or branch if a migration needs to be rolled back.
5. Start `web`, confirm `/healthz`, then start `worker`.
