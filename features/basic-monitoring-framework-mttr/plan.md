# HOK-2082 Implementation Plan

## Planning Summary

Implement a greenfield Python monitoring-agent package under `features/basic-monitoring-framework-mttr/`. The agent will scaffold the five MTTR stages and fully implement only the Classify stage. Classify will fetch the latest CloudWatch Health Report from S3, render the supplied classifier prompt, call OpenRouter, parse and validate JSON output, and return a structured result that downstream stages can consume later.

The repository currently has no application code beyond `LICENSE` and task-planning artifacts. There are no existing source conventions to preserve, so the implementation should establish a small, typed Python 3.11 project with focused modules, offline unit tests, and explicit runtime configuration.

## Research Findings

- The expanded task packet exists at `features/basic-monitoring-framework-mttr/task-packet.md`.
- The post-expansion router result is saved at `features/basic-monitoring-framework-mttr/.post-expansion-route.json`.
- The repo is effectively empty on branch `task/basic-monitoring-framework-mttr`; implementation will be additive.
- No database migration work is required. The packet explicitly says no persistence is introduced and data migration rollback is N/A, so no migration marker was created.
- The packet specifies Python 3.11+, `boto3`, `httpx`, `pydantic` v2, `pytest`, `ruff`, and `mypy`.
- External calls must be routed through standard AWS S3 access and OpenRouter's chat completions API.
- Tests must not make live S3 or OpenRouter calls.

## Architectural Decisions

1. Use a self-contained Python project rooted at `features/basic-monitoring-framework-mttr/`.
   - Reason: the repo has no existing package layout, and the issue scopes all new code to this feature directory.

2. Model the LLM output with Pydantic v2.
   - Reason: the task requires strict JSON schema validation, enum validation, and confidence bounds.

3. Keep the prompt in a Markdown template file.
   - Reason: it preserves the supplied classifier instructions and makes later prompt iteration easy without changing orchestration code.

4. Use an async loop scaffold with non-blocking stage dispatch.
   - Reason: future incident stages may run longer than one monitoring loop. The loop should schedule stages as tasks and collect completed results without blocking the dispatch path.

5. Keep Classify as the only implemented business stage.
   - Reason: Investigate, Mitigate, Restore, and Verify are explicitly out of scope for this issue.

6. Return structured stage failures instead of crashing the loop.
   - Reason: monitoring should continue even when S3, OpenRouter, or model output validation fails.

## Files To Add

- `features/basic-monitoring-framework-mttr/pyproject.toml`
  - Package metadata, Python version, dependencies, and tool config for pytest, ruff, and mypy.

- `features/basic-monitoring-framework-mttr/README.md`
  - Runtime instructions, environment variables, defaults, and local validation commands.

- `features/basic-monitoring-framework-mttr/agent/__init__.py`
  - Package marker and optional version export.

- `features/basic-monitoring-framework-mttr/agent/config.py`
  - Env-driven config object and typed `ConfigError`.

- `features/basic-monitoring-framework-mttr/agent/health_report.py`
  - S3 fetch logic and typed report-fetch exceptions.

- `features/basic-monitoring-framework-mttr/agent/openrouter_client.py`
  - HTTP client for OpenRouter chat completions and typed API exceptions.

- `features/basic-monitoring-framework-mttr/agent/models.py`
  - Pydantic models and enums for classification output, incidents, findings, signals, investigation plans, and stage results.

- `features/basic-monitoring-framework-mttr/agent/loop.py`
  - Five-stage loop scaffold, non-blocking dispatch, one-pass entrypoint, and JSON output.

- `features/basic-monitoring-framework-mttr/agent/stages/__init__.py`
  - Stage package marker.

- `features/basic-monitoring-framework-mttr/agent/stages/classify.py`
  - Classify orchestration: fetch report, render prompt, call LLM, parse, validate, retry once, return result.

- `features/basic-monitoring-framework-mttr/agent/stages/placeholders.py`
  - No-op placeholders for Investigate, Mitigate, Restore, and Verify.

- `features/basic-monitoring-framework-mttr/agent/prompts/classify.md`
  - Supplied classifier prompt with ASCII JSON quotes and `{{HEALTH_REPORT}}` placeholder.

- `features/basic-monitoring-framework-mttr/tests/test_classify.py`
  - Classify orchestration, prompt rendering, retry, schema, and healthy report behavior.

- `features/basic-monitoring-framework-mttr/tests/test_health_report.py`
  - S3 fetch success and failure behavior with mocked clients.

- `features/basic-monitoring-framework-mttr/tests/test_openrouter_client.py`
  - OpenRouter request shape, response parsing, timeout, non-2xx, and malformed API response handling.

- `features/basic-monitoring-framework-mttr/tests/test_loop.py`
  - Non-blocking dispatch and placeholder stage behavior.

- `features/basic-monitoring-framework-mttr/tests/fixtures/sample_report.md`
  - The sample Hokusai CloudWatch Health Report from the issue.

## Implementation Phases

### Phase 1: Project Scaffold

1. Create `pyproject.toml` with:
   - Python `>=3.11`.
   - Runtime dependencies: `boto3`, `httpx`, `pydantic>=2`.
   - Dev dependencies or optional test group: `pytest`, `pytest-mock`, `ruff`, `mypy`.
   - `ruff`, `mypy`, and `pytest` configuration scoped to `agent/` and `tests/`.

2. Create the package and test directories.

3. Add `README.md` with:
   - Required and optional env vars.
   - Example one-pass run command.
   - Offline test/lint/type-check commands.
   - Note that scheduling/deployment is intentionally out of scope.

### Phase 2: Config and Error Types

1. Implement `AgentConfig` in `agent/config.py` with defaults:
   - `HEALTH_REPORT_BUCKET=hokusai-health-reports-development`
   - `HEALTH_REPORT_KEY=latest/development/report.md`
   - `AWS_REGION=us-east-1`
   - `OPENROUTER_BASE_URL=https://openrouter.ai/api/v1`
   - `OPENROUTER_MODEL` with a reasonable documented default.
   - `OPENROUTER_TIMEOUT_SECONDS=60`

2. Require `OPENROUTER_API_KEY` only when creating a real OpenRouter client, so tests and prompt rendering can run without secrets.

3. Ensure config errors name missing variables but never include secret values.

### Phase 3: Classification Schema

1. Add enums for severity:
   - `NONE`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`

2. Add enums for incident taxonomy:
   - `DEPLOYMENT_REGRESSION`
   - `RESOURCE_EXHAUSTION`
   - `AUTH_FAILURE`
   - `DATABASE_DEGRADATION`
   - `EXTERNAL_DEPENDENCY_FAILURE`
   - `CONFIGURATION_DRIFT`
   - `NETWORK_CONNECTIVITY`
   - `TRAFFIC_ANOMALY`
   - `APPLICATION_ERROR`
   - `BACKGROUND_JOB_FAILURE`
   - `DATA_PIPELINE_FAILURE`
   - `STORAGE_DEGRADATION`
   - `CACHE_DEGRADATION`
   - `RATE_LIMITING`
   - `SECURITY_EVENT`
   - `OBSERVABILITY_FAILURE`
   - `UNKNOWN`

3. Add Pydantic models for:
   - `Signals`
   - `InvestigationPlan`
   - `Incident`
   - `Finding`
   - `ClassificationResult`
   - `StageResult` or equivalent wrapper with `status`, `output`, and `error`.

4. Constrain confidence fields to `[0.0, 1.0]`.

### Phase 4: Health Report Fetcher

1. Implement `fetch_latest_report(config, s3_client=None) -> str`.

2. Use `boto3.client("s3", region_name=config.aws_region)` when no client is injected.

3. Decode the S3 object body as UTF-8.

4. Raise typed exceptions for:
   - Missing bucket/key.
   - Access denied or credentials problems.
   - Empty report body.
   - Other S3 client errors.

5. Include bucket/key context in errors, but never credentials.

### Phase 5: OpenRouter Client

1. Implement `OpenRouterClient.complete(messages, model=None) -> str`.

2. POST to `{OPENROUTER_BASE_URL}/chat/completions`.

3. Include:
   - `Authorization: Bearer <OPENROUTER_API_KEY>`
   - `Content-Type: application/json`
   - JSON body with `model` and `messages`.

4. Parse `choices[0].message.content`.

5. Raise typed exceptions for:
   - Timeout.
   - Network/connectivity failure.
   - Non-2xx response, with status and short response snippet.
   - 2xx response missing assistant content.

6. Ensure exception messages do not leak the API key.

### Phase 6: Prompt Template

1. Add `agent/prompts/classify.md`.

2. Preserve the issue's classifier prompt and output contract.

3. Normalize smart quotes and escaped examples into valid ASCII JSON in the prompt.

4. Implement prompt rendering with `template.replace("{{HEALTH_REPORT}}", report, 1)`.

5. Treat report text as literal content, including braces.

### Phase 7: Classify Stage

1. Implement orchestration:
   - Load config.
   - Fetch report.
   - Render prompt.
   - Call OpenRouter.
   - Strip accidental Markdown code fences if present.
   - `json.loads`.
   - Validate with Pydantic.
   - Return a successful stage result with validated classification.

2. On JSON parse or schema validation failure:
   - Retry exactly once with a corrective instruction telling the model to return valid JSON matching the required schema.
   - If the second response is still invalid, return a failed `StageResult` with `error` populated.

3. On S3 or OpenRouter exceptions:
   - Return a failed `StageResult`.
   - Do not raise out of the stage loop.

4. Do not add root-cause analysis or remediation logic.

### Phase 8: Non-Blocking Loop Scaffold

1. Define the five stage names in order:
   - Classify
   - Investigate
   - Mitigate
   - Restore
   - Verify

2. Implement a loop runner that can run one iteration for tests and smoke usage.

3. Dispatch stages as async tasks so stage execution does not block the scheduling path.

4. For this issue, Classify may be awaited in a one-shot CLI command after dispatch so the command can print output, but the loop abstraction must support background tasks and completed-task collection.

5. Implement placeholders for downstream stages returning `status="not_implemented"` immediately.

6. Capture stage exceptions into failed results rather than crashing the loop.

### Phase 9: Tests

1. `test_health_report.py`
   - Successful fetch returns exact fixture text.
   - Missing key maps to not-found exception.
   - Access denied or credentials error maps to fetch exception without secret leakage.
   - Empty report maps to empty-report exception.

2. `test_openrouter_client.py`
   - Successful completion returns assistant message content.
   - Request includes expected endpoint, auth header, model, and messages.
   - Timeout maps to timeout exception.
   - HTTP 401 maps to API exception with status but no API key.
   - Empty choices maps to response exception.

3. `test_classify.py`
   - Prompt rendering inserts report and removes template placeholder.
   - Healthy fixture plus mocked no-incident JSON validates as `overall_severity == "NONE"` and `incidents == []`.
   - JSON wrapped in Markdown fences is accepted.
   - Malformed first response plus valid second response triggers exactly one retry and succeeds.
   - Two malformed or invalid responses return an error result, not an uncaught exception.
   - Invalid enum or confidence out of range triggers retry.

4. `test_loop.py`
   - All five stages are registered in order.
   - Placeholders return `not_implemented`.
   - One loop iteration dispatches stages without requiring downstream stage implementation.
   - A stage exception is converted into a failed result and the loop continues.

### Phase 10: Documentation and Verification

1. README must list:
   - `OPENROUTER_API_KEY`
   - `OPENROUTER_MODEL`
   - `OPENROUTER_BASE_URL`
   - `OPENROUTER_TIMEOUT_SECONDS`
   - `HEALTH_REPORT_BUCKET`
   - `HEALTH_REPORT_KEY`
   - `AWS_REGION`

2. README must clarify:
   - Tests are offline.
   - Live smoke run requires AWS credentials and OpenRouter key.
   - Scheduling/deployment is not implemented in this issue.

3. Coding phase should run from `features/basic-monitoring-framework-mttr/`:
   - `ruff check .`
   - `mypy agent`
   - `pytest -q`

4. Optional manual smoke:
   - `python -m agent.loop`
   - Expected with missing key: clear config error.
   - Expected with valid env/AWS: validated classification JSON or typed external-service error.

## Edge Cases To Handle

- S3 object is missing.
- S3 bucket is missing.
- AWS credentials are missing or access is denied.
- S3 object body is empty.
- Report contains braces or literal `{{HEALTH_REPORT}}` text.
- OpenRouter API key is unset.
- OpenRouter times out.
- OpenRouter returns non-2xx.
- OpenRouter returns 2xx with missing or empty choices.
- LLM returns Markdown-fenced JSON.
- LLM returns malformed JSON twice.
- LLM returns valid JSON with invalid enum values.
- LLM returns confidence outside `[0.0, 1.0]`.
- A stage raises unexpectedly during loop execution.

## Constraints for Coding Phase

- Do not implement Investigate, Mitigate, Restore, or Verify beyond placeholders.
- Do not add database persistence.
- Do not add scheduler, cron, Lambda, ECS task, Slack, PagerDuty, or other deployment/notification integrations.
- Do not make live S3 or OpenRouter calls from unit tests.
- Do not log or echo secrets.
- Keep all implementation files under `features/basic-monitoring-framework-mttr/`.

## Release Readiness

- `database_change_risk`: `none`
- `env_changes`: `OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_BASE_URL, OPENROUTER_TIMEOUT_SECONDS, HEALTH_REPORT_BUCKET, HEALTH_REPORT_KEY, AWS_REGION`
- `config_changes`: `features/basic-monitoring-framework-mttr/pyproject.toml`
- `manual_steps`: `Provision OPENROUTER_API_KEY and AWS credentials with S3 read access to hokusai-health-reports-development in the runtime environment`

## Approval Gate

After user approval, create:

`features/basic-monitoring-framework-mttr/.plan-approved`

Then stop immediately so the orchestrator can launch the coding phase.
