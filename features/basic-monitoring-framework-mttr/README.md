# Hokusai Monitoring Agent

This feature directory contains the initial MTTR monitoring-agent scaffold and a full implementation of the `Classify` stage.

## Environment

- `OPENROUTER_API_KEY`: required for live OpenRouter requests.
- `OPENROUTER_MODEL`: optional model override. Default: `openai/gpt-4.1-mini`.
- `OPENROUTER_BASE_URL`: optional API base URL. Default: `https://openrouter.ai/api/v1`.
- `OPENROUTER_TIMEOUT_SECONDS`: optional request timeout. Default: `60`.
- `HEALTH_REPORT_BUCKET`: optional S3 bucket override. Default: `hokusai-health-reports-development`.
- `HEALTH_REPORT_KEY`: optional S3 key override. Default: `latest/development/report.md`.
- `AWS_REGION`: optional AWS region override. Default: `us-east-1`.

## Usage

Run one monitoring iteration:

```bash
python -m agent.loop
```

Live runs require AWS credentials with read access to the health report bucket and a valid `OPENROUTER_API_KEY`.

## Verification

All tests are offline and mock S3 and OpenRouter.

```bash
ruff check .
mypy agent
pytest -q
```

Scheduling and deployment are intentionally out of scope for this issue.

