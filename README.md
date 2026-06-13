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
- `MONITOR_INTERVAL_MS` (`300000`)

The Investigate stage's tool loop and rate-limit behaviour are bounded by several budgets
(`INVESTIGATE_MAX_TOOL_ITERATIONS`, `INVESTIGATE_MAX_TOOL_CALLS`, `INVESTIGATE_LLM_TIMEOUT_MS`,
`INVESTIGATE_CONSECUTIVE_FAILURE_LIMIT`, `TOOL_*`, `OPENROUTER_*`, `AWS_MAX_ATTEMPTS`). See
`.env.example` for all of them.

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
        "lambda:ListVersionsByFunction",
        "events:DescribeRule",
        "events:ListTargetsByRule",
        "cloudtrail:LookupEvents",
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

No write/mutate actions are required or used. Scope the `Resource` for the CloudWatch
statements down to specific log groups / namespaces if your environment supports it. If these
permissions are missing, the Investigate tools return the error as evidence ("missing
telemetry") and the stage degrades to a triage / data-request result rather than failing.

## Architecture

### Stages

1. **Classify** (implemented): Analyzes the health report and produces structured incident
   classifications and findings.
2. **Investigate** (implemented): Takes the Classify output and investigates each item using a
   bounded, read-only agentic tool loop (CloudWatch Logs Insights + CloudWatch
   metrics/alarms over OpenRouter), producing a validated investigation with likely causes,
   evidence, data requests, and a per-item "ready for mitigation" signal. It never remediates.
3. **Mitigate** (stub): Future mitigation actions.
4. **Restore** (stub): Future service restoration.
5. **Verify** (stub): Future recovery verification.

### Investigate tool loop — bounded by design

The Investigate stage drives read-only tools through a multi-turn loop that cannot run away:

- per-run iteration and global tool-call budgets, then a forced final answer with no tools;
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
