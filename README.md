# Hokusai Monitoring Agent

Five-stage monitoring agent that classifies incidents from CloudWatch health reports.

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

All configuration is via environment variables. See `.env.example` for available options.

Required:
- `OPENROUTER_API_KEY`: OpenRouter API key for LLM access

Optional (with defaults):
- `OPENROUTER_MODEL`: LLM model to use (default: openai/gpt-4o-mini)
- `HEALTH_REPORT_S3_URI`: S3 URI for health report (default: s3://hokusai-health-reports-development/latest/development/report.md)
- `MONITOR_INTERVAL_MS`: Loop interval in milliseconds (default: 300000)

## Architecture

### Stages

1. **Classify** (implemented): Analyzes health reports and generates incident classifications
2. **Investigate** (stub): Future root-cause analysis
3. **Mitigate** (stub): Future mitigation actions
4. **Restore** (stub): Future service restoration
5. **Verify** (stub): Future recovery verification

### Non-blocking Orchestrator

The orchestrator runs on a loop without blocking on long-running stage execution. In-flight guards prevent overlapping Classify runs.
