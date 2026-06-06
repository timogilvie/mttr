## 1. Objective

### What
Implement a non-blocking five-stage monitoring-agent loop scaffold and fully build only the first stage (**Classify**), which consumes the latest Hokusai CloudWatch Health Report from S3 and produces a schema-validated incident classification via an LLM call routed through OpenRouter.

### Why
Hokusai needs to reduce Mean Time To Resolution (MTTR) by automatically triaging service health. The Classify stage turns a raw, human-readable health report into structured, machine-actionable incident hypotheses that downstream stages (Investigate, Mitigate, Restore, Verify) can act on independently. This issue delivers the foundation and the first working stage.

### Scope In
- A loop scaffold defining five stages: Classify, Investigate, Mitigate, Restore, Verify.
- Each stage is invoked in a **non-blocking** manner so long-running incidents do not stall the loop.
- Full implementation of **Classify**: fetch report from S3, build prompt, call OpenRouter, parse and validate JSON output.
- OpenRouter client with configurable model (via env/config).
- Prompt template file embedding the supplied first-draft classifier prompt with a `{{HEALTH_REPORT}}` placeholder.
- Pydantic (or equivalent) schema + validation of LLM output, with one retry on malformed JSON.
- Unit tests with the LLM and S3 calls mocked, including the sample healthy report producing `NONE`.
- README documenting how to run Classify and required env vars.

### Scope Out
- Implementation of Investigate, Mitigate, Restore, Verify (placeholders/stubs only).
- Persisting incidents to a database or external incident tracker.
- Generating the Health Report itself (already produced by an existing GitHub Action).
- Deploying/scheduling the agent (cron, ECS task, Lambda) — out of scope; loop is a runnable scaffold only.
- Alerting/notifications (Slack, PagerDuty).
- Real (non-mocked) calls to OpenRouter or S3 in CI tests.

---

## 2. Technical Context

### Repository
Work happens in this repo on branch `task/basic-monitoring-framework-mttr`. The repo is effectively empty (only `LICENSE` and an empty `features/basic-monitoring-framework-mttr/` directory at `22937fe Initial commit`). All new code lives under `features/basic-monitoring-framework-mttr/`.

### Key Files
- `features/basic-monitoring-framework-mttr/agent/__init__.py` (new) — package marker
- `features/basic-monitoring-framework-mttr/agent/loop.py` (new) — five-stage loop scaffold, non-blocking dispatch
- `features/basic-monitoring-framework-mttr/agent/stages/__init__.py` (new) — package marker
- `features/basic-monitoring-framework-mttr/agent/stages/classify.py` (new) — Classify stage: orchestrates fetch → prompt → LLM → validate
- `features/basic-monitoring-framework-mttr/agent/stages/placeholders.py` (new) — stub `investigate`, `mitigate`, `restore`, `verify` callables
- `features/basic-monitoring-framework-mttr/agent/health_report.py` (new) — `fetch_latest_report()` from S3
- `features/basic-monitoring-framework-mttr/agent/openrouter_client.py` (new) — `OpenRouterClient.complete()`
- `features/basic-monitoring-framework-mttr/agent/models.py` (new) — Pydantic models for the classification schema
- `features/basic-monitoring-framework-mttr/agent/prompts/classify.md` (new) — prompt template with `{{HEALTH_REPORT}}`
- `features/basic-monitoring-framework-mttr/agent/config.py` (new) — env-driven config (bucket, key, model, API key)
- `features/basic-monitoring-framework-mttr/tests/test_classify.py` (new) — unit tests (mocked S3 + OpenRouter)
- `features/basic-monitoring-framework-mttr/tests/test_health_report.py` (new) — S3 fetch tests
- `features/basic-monitoring-framework-mttr/tests/fixtures/sample_report.md` (new) — the sample healthy report from the issue
- `features/basic-monitoring-framework-mttr/pyproject.toml` (new) — deps + tooling config
- `features/basic-monitoring-framework-mttr/README.md` (new) — run instructions + env vars

> **Stack note**: No existing code or language convention exists in the repo. Given the AWS S3 source, LLM orchestration, and CloudWatch domain, this packet specifies **Python 3.11+** with `boto3` (S3), `httpx` (OpenRouter HTTP), and `pydantic` v2 (schema validation), tested with `pytest`. If a maintainer prefers a different stack, that decision should be made before implementation begins.

### Relevant Subsystem Specs

> ⚠️ **Knowledge Gap**: No subsystem specs (`.wavemill/context/`) were found for this area. This is a brand-new subsystem. After implementation, run `wavemill context init --force` to document the monitoring-agent patterns (stage interface, OpenRouter client, classification schema) and enable persistent downstream acceleration for the remaining four stages.

### Dependencies
- **AWS S3**: read access to bucket `hokusai-health-reports-development`, key `latest/development/report.md`. Requires AWS credentials in the runtime environment (standard boto3 credential chain).
- **OpenRouter**: HTTPS API at `https://openrouter.ai/api/v1/chat/completions`. Requires `OPENROUTER_API_KEY`.
- **Python packages**: `boto3`, `httpx`, `pydantic>=2`, `pytest`, `pytest-mock` (or `moto` for S3 mocking), `ruff` (lint), `mypy` (types).
- No dependency on other in-flight issues (this is the first commit in the repo).

### Architecture Notes
- **Stage interface**: define a uniform stage signature, e.g. `def run(context: StageContext) -> StageResult`. The loop submits each stage to a non-blocking executor (`asyncio` tasks or `concurrent.futures.ThreadPoolExecutor`). Classify is the only stage with real logic; the other four return a `NotImplemented`-style placeholder result.
- **Non-blocking requirement**: the loop must dispatch stage work without `.join()`/awaiting completion inline for long-running incident work. Document the chosen concurrency primitive in `loop.py` docstring.
- **Prompt construction**: load `prompts/classify.md`, replace `{{HEALTH_REPORT}}` with the fetched report text. Keep the classifier instructions verbatim from the issue's first-draft prompt (normalize the smart quotes `"` `"` to ASCII `"` in the JSON example so the model is shown valid JSON).
- **Output contract**: LLM is instructed to return JSON only. Parse with `json.loads`; on failure, retry once with a corrective system message; on second failure, return a structured error result (do not crash the loop).
- **Config**: all external identifiers (bucket, key, model id, base url) come from `config.py` with env overrides and sane defaults.

---

## 3. Implementation Approach

1. **Scaffold package + tooling** — create `pyproject.toml` with deps and `ruff`/`mypy`/`pytest` config; create `agent/` and `tests/` package structure. Why: establishes a runnable, lintable baseline.
2. **Config module** (`config.py`) — read `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (default e.g. `anthropic/claude-3.5-sonnet`), `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`), `HEALTH_REPORT_BUCKET` (default `hokusai-health-reports-development`), `HEALTH_REPORT_KEY` (default `latest/development/report.md`), `AWS_REGION` (default `us-east-1`). Raise a clear `ConfigError` when a required value (API key) is missing.
3. **Health report fetch** (`health_report.py`) — `fetch_latest_report(config) -> str` using `boto3` S3 `get_object`. Handle `NoSuchKey`, `NoSuchBucket`, `ClientError`/credential errors, and empty body with explicit exceptions/messages.
4. **OpenRouter client** (`openrouter_client.py`) — `complete(messages, model) -> str` via `httpx.post` with auth header, JSON body, configurable timeout (default 60s). Handle non-2xx, timeouts, and connection errors with typed exceptions; surface the HTTP status and response snippet.
5. **Schema models** (`models.py`) — Pydantic models for `Classification`, `Incident`, `Finding`, `InvestigationPlan`, `Signals`, with enums for `classification` (the 17-value taxonomy incl. UNKNOWN/OBSERVABILITY_FAILURE) and `severity` (NONE/LOW/MEDIUM/HIGH/CRITICAL). `confidence` constrained to 0.0–1.0.
6. **Prompt template** (`prompts/classify.md`) — store the issue's first-draft classifier prompt verbatim (ASCII-quoted JSON example) ending with `Analyze the following health report:\n\n{{HEALTH_REPORT}}`.
7. **Classify stage** (`stages/classify.py`) — orchestrate: fetch report → render prompt → call OpenRouter → strip any accidental markdown fences → `json.loads` → validate with Pydantic. On parse/validation failure, retry once with a corrective instruction; on repeated failure return a `ClassifyResult` with `error` populated. Why: meets "non-blocking, resilient stage" requirement.
8. **Loop scaffold** (`loop.py`) — define `StageContext`/`StageResult`, register the five stages, dispatch Classify non-blocking, and run placeholders for the rest. Provide a `if __name__ == "__main__"` entrypoint that runs one Classify pass and prints the validated JSON.
9. **Placeholders** (`stages/placeholders.py`) — `investigate/mitigate/restore/verify` returning `StageResult(status="not_implemented")`.
10. **Tests** — mock S3 (moto or monkeypatched client) and OpenRouter (`httpx` mock); assert sample healthy report → `NONE`; assert malformed-JSON retry path; assert S3/OpenRouter error handling. Why: satisfies Section 6 without live calls.
11. **README** — document env vars, how to run `python -m agent.loop`, and how to swap the model.

---

## 4. Success Criteria

### Functional Requirements
- [ ] **[REQ-F1]** `fetch_latest_report()` returns the report body as a `str` for bucket `hokusai-health-reports-development` / key `latest/development/report.md`, and raises a typed, message-bearing exception on missing key, missing bucket, missing credentials, or empty body.
- [ ] **[REQ-F2]** The Classify stage renders the prompt by replacing exactly the `{{HEALTH_REPORT}}` token in `prompts/classify.md` with the fetched report text (no other tokens altered) and sends it to OpenRouter using the configured model.
- [ ] **[REQ-F3]** The OpenRouter client sends a POST to `{base_url}/chat/completions` with `Authorization: Bearer <key>`, returns the assistant message content as a `str`, and raises typed exceptions on timeout, connection error, and non-2xx responses (including the status code in the message).
- [ ] **[REQ-F4]** The LLM response is parsed and validated against the classification schema; `classification` ∈ the 17-value taxonomy, `severity` ∈ {NONE,LOW,MEDIUM,HIGH,CRITICAL}, `confidence` ∈ [0.0,1.0]. Invalid values raise a validation error that triggers exactly one corrective retry.
- [ ] **[REQ-F5]** Given the sample healthy report fixture, the Classify stage (with a mocked LLM returning the documented "no incidents" JSON) yields a validated result with `overall_severity == "NONE"` and `incidents == []`.
- [ ] **[REQ-F6]** The loop scaffold registers all five stages, dispatches Classify in a non-blocking manner (does not block on long-running incident work), and runs `investigate/mitigate/restore/verify` as placeholders returning `status == "not_implemented"`.
- [ ] **[REQ-F7]** On two consecutive unparseable/invalid LLM responses, the Classify stage returns a `ClassifyResult` whose `error` field is populated and does not raise out of the stage (loop continues).

### Non-Functional Requirements
- [ ] OpenRouter HTTP timeout defaults to 60s and is configurable; no unbounded hangs.
- [ ] No secrets are logged (API key must never appear in logs or exceptions).
- [ ] All CI tests run fully offline (S3 and OpenRouter mocked); no network calls in the test suite.

### Code Quality
- [ ] Follows a consistent, documented Python layout (the repo has no prior convention; establish a clean one).
- [ ] Type hints on all public functions; `mypy` clean (no implicit `Any` on public signatures).
- [ ] No lint errors (`ruff`).

---

## 5. Implementation Constraints

- **Code style**: Python 3.11+, type-hinted, formatted/linted with `ruff`; modules small and single-responsibility. Match this style across all new files since no prior convention exists.
- **Scope discipline**: Implement Classify only. Investigate/Mitigate/Restore/Verify MUST remain non-functional placeholders. Do not add DB persistence, schedulers, or notifications.
- **LLM routing**: All model calls go through OpenRouter; model id is configurable (env `OPENROUTER_MODEL`). Do not hardcode a single vendor SDK.
- **Faithfulness**: Do not alter the semantics of the supplied classifier prompt; only normalize smart quotes to ASCII so the embedded JSON example is valid. The model must be instructed to return JSON only.
- **Resilience / non-blocking**: A failure in any single stage or LLM call must not crash the loop. Classify must dispatch in a non-blocking way.
- **Security**: Never log `OPENROUTER_API_KEY` or AWS credentials. Read all secrets from env, never commit them.
- **Testing**: No live S3 or OpenRouter calls in tests; use mocks/fixtures. The sample report from the issue must be saved as a fixture.
- **Backwards compatibility**: N/A — first feature in the repo; no existing consumers.

---

## 6. Validation Steps

### Functional Requirement Validation

**[REQ-F1] Fetch latest report from S3**

Validation scenario:
1. Setup: Mock the S3 client (moto or monkeypatched) so `get_object(Bucket="hokusai-health-reports-development", Key="latest/development/report.md")` returns the `sample_report.md` body.
2. Action: Call `fetch_latest_report(config)`.
3. Expected result: Returns the exact report text (string starting with `# Hokusai Service Health Report`).
4. Edge cases:
   - Key missing (`NoSuchKey`) → raises `HealthReportNotFoundError` with message naming bucket+key.
   - Missing/invalid AWS credentials (`NoCredentialsError`/`ClientError` AccessDenied) → raises `HealthReportFetchError` mentioning credentials/access; secrets not echoed.
   - Empty object body → raises `HealthReportEmptyError`.

**[REQ-F2] Prompt rendering**

Validation scenario:
1. Setup: `prompts/classify.md` loaded; report text = `"REPORT_BODY_123"`.
2. Action: Render the prompt for Classify.
3. Expected result: Output contains `REPORT_BODY_123`, contains the literal instruction `You are the Classify stage`, and contains **no** remaining `{{HEALTH_REPORT}}` substring.
4. Edge cases:
   - Report text containing `{` and `}` braces → inserted verbatim, not treated as format placeholders (use `str.replace`, not `str.format`).
   - Report text containing the literal string `{{HEALTH_REPORT}}` inside it → only the template's token is replaced once (single replacement of template placeholder).

**[REQ-F3] OpenRouter client**

Validation scenario:
1. Setup: Mock `httpx` to return 200 with `{"choices":[{"message":{"content":"{...json...}"}}]}`.
2. Action: Call `client.complete(messages, model="anthropic/claude-3.5-sonnet")`.
3. Expected result: Returns the `content` string; request had header `Authorization: Bearer <key>` and JSON body with `model` and `messages`.
4. Edge cases:
   - Mock raises `httpx.TimeoutException` → raises `OpenRouterTimeoutError`.
   - Mock returns HTTP 401 → raises `OpenRouterAPIError` containing `401`; API key value NOT in the message.
   - Mock returns 200 with empty `choices` → raises `OpenRouterResponseError`.

**[REQ-F4 / REQ-F7] Schema validation + retry**

Validation scenario:
1. Setup: Mock OpenRouter to return malformed JSON (`"not json"`) on first call, valid "no incidents" JSON on second call.
2. Action: Run Classify.
3. Expected result: Exactly two LLM calls made; final result validates and `overall_severity == "NONE"`.
4. Edge cases:
   - Both calls malformed → Classify returns `ClassifyResult` with non-null `error`, no exception propagates (REQ-F7).
   - Valid JSON but `severity == "WORSE"` (not in enum) → triggers the one corrective retry; if still invalid, `error` populated.

**[REQ-F5] Sample healthy report → NONE**

Validation scenario:
1. Setup: S3 mock returns `sample_report.md`; OpenRouter mock returns the documented no-incident JSON (`{"summary":"No actionable incidents detected.","overall_severity":"NONE","incidents":[],"findings":[]}`).
2. Action: Run one Classify pass.
3. Expected result: Validated model with `overall_severity == "NONE"`, `incidents == []`.
4. Edge cases:
   - LLM returns JSON wrapped in ```json fences → fences stripped before parsing, still validates.
   - LLM returns one MEDIUM incident with `confidence == 0.9` → validates; `incidents` length 1, `overall_severity` preserved as returned.

**[REQ-F6] Loop scaffold non-blocking + placeholders**

Validation scenario:
1. Setup: Loop configured with Classify (mocked LLM/S3) and the four placeholder stages.
2. Action: Run one loop iteration.
3. Expected result: Classify result returned; calling `investigate/mitigate/restore/verify` each returns `StageResult(status="not_implemented")`.
4. Edge cases:
   - Classify stage raises internally → loop captures it as a failed `StageResult` and continues to next stage (no crash).
   - A placeholder stage invoked → returns immediately, does not call OpenRouter or S3.

### Input/Output Verification

**Valid Inputs:**
- Input: sample healthy report + no-incident LLM JSON → Output: validated `Classification(overall_severity="NONE", incidents=[])`.
- Input: report + LLM JSON with one `OBSERVABILITY_FAILURE` MEDIUM incident (confidence 0.6) → Output: validated model, 1 incident, classification enum accepted.

**Invalid Inputs:**
- Input: LLM returns `"oops"` twice → Output: `ClassifyResult.error` populated, no raise.
- Input: LLM JSON with `confidence: 1.5` → Output: validation error → one retry; if persists, `error` populated.
- Input: S3 key absent → Output: `HealthReportNotFoundError` raised by fetch, caught by stage into failed `StageResult`.

### Standard Validation Commands

```bash
# Run from features/basic-monitoring-framework-mttr/

# 1. Lint passes
ruff check .
# Expected: no errors

# 2. Type check passes
mypy agent
# Expected: no type errors

# 3. Tests pass (fully offline)
pytest -q
# Expected: all tests pass, no network access

# 4. Smoke run (requires env vars; or use a stub)
python -m agent.loop
# Expected: prints validated classification JSON or a clear config error if env unset
```

### Manual Verification Checklist

- [ ] With `OPENROUTER_API_KEY` unset, `python -m agent.loop` exits with a clear `ConfigError` naming the missing variable (not a stack trace about None).
- [ ] `prompts/classify.md` contains the full taxonomy (17 classifications), the five severity definitions, and the JSON example uses ASCII quotes (valid JSON).
- [ ] Grep the codebase/logs to confirm the API key string never appears in any log statement.
- [ ] README lists every env var (`OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_BASE_URL`, `HEALTH_REPORT_BUCKET`, `HEALTH_REPORT_KEY`, `AWS_REGION`) with defaults.

---

## 8. Definition of Done

- [ ] All success criteria (REQ-F1–F7 + non-functional) met
- [ ] All validation steps pass with specific, measurable outcomes
- [ ] Each functional requirement has at least one concrete validation scenario
- [ ] Edge cases documented and tested (malformed JSON, S3 errors, OpenRouter errors)
- [ ] Investigate/Mitigate/Restore/Verify remain placeholders only
- [ ] No unrelated changes included
- [ ] Commit message references HOK-2082
- [ ] PR created with clear description and linked to the Linear issue
- [ ] Post-implementation: recommend `wavemill context init --force` to document the new monitoring-agent subsystem

---

## 9. Rollback Plan

- This is additive, net-new code under `features/basic-monitoring-framework-mttr/` with no existing consumers. Rollback is low-risk.
- Revert commit: `git revert <sha>` (or delete the feature directory) — removes the agent entirely with no migration or data impact.
- Feature flag: N/A — the loop is not auto-scheduled; it only runs when explicitly invoked.
- Data migration rollback: N/A — no persistence introduced.

---

## 10. Release Readiness
- **database_change_risk**: none
- **env_changes**: OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_BASE_URL, HEALTH_REPORT_BUCKET, HEALTH_REPORT_KEY, AWS_REGION
- **config_changes**: features/basic-monitoring-framework-mttr/pyproject.toml
- **manual_steps**: Provision OPENROUTER_API_KEY and AWS credentials with S3 read access to hokusai-health-reports-development in the runtime environment

---

## 11. Proposed Labels

**Risk Level** (Required):

**Selected**: `Risk: Medium`

**Justification**: Medium — net-new subsystem with external integrations (S3, OpenRouter) and concurrency, but fully additive with no existing consumers, no DB changes, and not auto-scheduled. Risk is contained to a new isolated feature directory.

---

**Files to Modify** (Auto-detected):
- `features/basic-monitoring-framework-mttr/agent/stages/classify.py`
- `features/basic-monitoring-framework-mttr/agent/openrouter_client.py`
- `features/basic-monitoring-framework-mttr/agent/health_report.py`
- `features/basic-monitoring-framework-mttr/agent/loop.py`
- `features/basic-monitoring-framework-mttr/agent/prompts/classify.md`

**Label**: `Files: classify.py, openrouter_client.py, health_report.py, loop.py, classify.md`

**Purpose**: Prevents parallel tasks from modifying the same files

---

**Architectural Layer** (Recommended):

**Selected**: `Layer: Service`

**Purpose**: Backend business logic / agent orchestration; can run in parallel with UI tasks.

---

**Area** (Recommended):

**Selected**: `Area: Monitoring` (MTTR monitoring agent)

**Purpose**: Avoid running 2+ tasks affecting the monitoring-agent area concurrently.

---

**Test Coverage** (Auto-detected):

**Selected**: `Tests: Unit`

**Purpose**: Unit tests with mocked S3/OpenRouter; can run in parallel with other unit-test tasks.

---

**Component** (Optional):

**Selected**: `Component: ClassifyStage`

**Purpose**: Avoid concurrent edits to the Classify stage.

---

### Label Summary

```
Suggested labels for this task:
- Risk: Medium
- Files: classify.py, openrouter_client.py, health_report.py, loop.py, classify.md
- Layer: Service
- Area: Monitoring
- Tests: Unit
- Component: ClassifyStage
```

**How these labels help the autonomous workflow:**
- **Risk: Medium** — Max 2 Medium risk tasks can run in parallel
- **Files: ...** — Prevents file conflicts with other tasks
- **Layer: Service** — Can run in parallel with UI/Database/Infra tasks
- **Area: Monitoring** — Prevents conflicts with future Investigate/Mitigate/Restore/Verify tasks
- **Tests: Unit** — Can run in parallel with other Unit test tasks
- **Component: ClassifyStage** — Prevents conflicts with other Classify-stage tasks