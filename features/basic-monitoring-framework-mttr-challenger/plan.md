# HOK-2082 Planning Phase: Basic Monitoring Framework - MTTR

## Planning Artifacts

- Expanded task packet: `features/basic-monitoring-framework-mttr-challenger/task-packet.md`
- Post-expansion route: `features/basic-monitoring-framework-mttr-challenger/.post-expansion-route.json`
- Migration marker: not created; no migration work detected. The packet explicitly scopes out persistence/database work and states there are no database migrations to roll back.

## Codebase Research Summary

The repository is greenfield. The current branch is `task/basic-monitoring-framework-mttr-challenger`; `git ls-tree` shows only `LICENSE` in `HEAD`, and the working tree contains only generated planning artifacts under `features/basic-monitoring-framework-mttr-challenger/`.

There are no existing source conventions to preserve. The implementation should therefore establish a small, strict TypeScript service layout at repository root while keeping all behavior additive and self-contained.

Key constraints from the task packet:

- Implement the five-stage monitoring-agent framework, but fully implement only `Classify`.
- `Investigate`, `Mitigate`, `Restore`, and `Verify` must be typed no-op stubs.
- Classify must fetch the latest markdown health report from S3.
- Classify must build the provided prompt with the health report substituted for `{{HEALTH_REPORT}}`.
- LLM access must go through OpenRouter, with model configurable through environment.
- The stage output must be parsed and validated against the required incident-classification JSON schema before return.
- The orchestrator must schedule stages without blocking the loop on long-running async work.
- Tests must mock external services; no real S3/OpenRouter calls in automated tests.

## Recommended Architecture

Use a root-level Node 20+ TypeScript project with ESM modules, strict type checking, Vitest, ESLint, the AWS SDK v3 S3 client, and `zod`.

Proposed module layout:

- `package.json`: scripts and dependencies.
- `tsconfig.json`: strict TypeScript config.
- `.eslintrc.cjs`: TypeScript ESLint config.
- `.gitignore`: ignore `node_modules`, `dist`, `.env`.
- `.env.example`: document required and optional env vars.
- `README.md`: concise run/test/config notes.
- `src/index.ts`: load config and start orchestrator.
- `src/config.ts`: environment parsing and validation.
- `src/types.ts`: shared stage and classification types.
- `src/orchestrator.ts`: non-blocking loop and in-flight guard.
- `src/report/fetchReport.ts`: S3 URI parsing and report fetch.
- `src/llm/openrouter.ts`: OpenRouter chat-completions client.
- `src/prompts/classifyPrompt.ts`: prompt template and substitution.
- `src/stages/classify.ts`: Classify stage orchestration.
- `src/stages/stubs.ts`: four no-op stage implementations.
- `src/validation/classificationSchema.ts`: zod schema and parser.
- `src/__tests__/*.test.ts`: unit tests.
- `test/fixtures/report.md`: issue sample report fixture.

## Implementation Plan

### Phase 1: Project scaffold

1. Create `package.json` with scripts:
   - `build`: `tsc`
   - `typecheck`: `tsc --noEmit`
   - `lint`: `eslint .`
   - `test`: `vitest run`
   - `start`: `tsx src/index.ts`
2. Add runtime dependencies:
   - `@aws-sdk/client-s3`
   - `zod`
3. Add dev dependencies:
   - `typescript`
   - `tsx`
   - `vitest`
   - `eslint`
   - `@typescript-eslint/eslint-plugin`
   - `@typescript-eslint/parser`
   - `@types/node`
4. Add `tsconfig.json` with strict settings and Node-compatible ESM output.
5. Add `.gitignore`, `.env.example`, and a concise `README.md`.

Decision: prefer a minimal service scaffold over framework code. There is no UI, persistence, deployment, or existing package structure.

### Phase 2: Shared contracts and validation

1. Define `Severity` as `NONE | LOW | MEDIUM | HIGH | CRITICAL`.
2. Define the full incident taxonomy as a string union.
3. Define `ClassificationResult`, `Incident`, `Finding`, `InvestigationPlan`, `IncidentSignals`, `Stage`, `StageInput`, and `StageResult`.
4. Implement `classificationSchema.ts` using `zod`:
   - Required top-level keys: `summary`, `overall_severity`, `incidents`, `findings`.
   - Incident fields exactly as required by the issue.
   - Finding fields exactly as required by the issue.
   - Confidence constrained to `[0, 1]`.
   - Enum validation for severity and classification.
5. Add `ClassificationValidationError` that includes the first failing path in its message.

Decision: validate at the LLM boundary with `unknown` input rather than trusting generated JSON. This keeps downstream stages typed and predictable.

### Phase 3: Configuration

1. Implement `loadConfig()` in `src/config.ts`.
2. Required env var:
   - `OPENROUTER_API_KEY`
3. Defaulted env vars:
   - `OPENROUTER_MODEL=openai/gpt-4o-mini`
   - `OPENROUTER_BASE_URL=https://openrouter.ai/api/v1`
   - `HEALTH_REPORT_S3_URI=s3://hokusai-health-reports-development/latest/development/report.md`
   - `AWS_REGION=us-east-1`
   - `MONITOR_INTERVAL_MS=300000`
   - `LLM_TIMEOUT_MS=60000`
   - `S3_TIMEOUT_MS=15000`
4. Validate numeric env vars and fail fast with messages naming the invalid variable.

Decision: keep S3 URI, model, timeouts, and interval configurable so the agent can be tested across environments without code changes.

### Phase 4: S3 report fetching

1. Implement S3 URI parsing for `s3://bucket/key`.
2. Reject non-S3 URIs and empty bucket/key values with `ReportFetchError`.
3. Use `S3Client` and `GetObjectCommand` from AWS SDK v3.
4. Use `AbortController` for timeout enforcement.
5. Convert the response body to UTF-8 text.
6. Treat missing or empty body as an explicit error.
7. Preserve useful cause details without logging secrets.

Edge cases:

- Invalid URI.
- `NoSuchKey`.
- Empty body.
- Timeout.
- AWS auth/permission error.
- Stream conversion failure.

### Phase 5: Prompt builder

1. Store the provided first-draft classifier prompt in `CLASSIFY_PROMPT_TEMPLATE`.
2. Keep the prompt text faithful to the issue, including taxonomy, severity definitions, classification rules, required output, and the `{{HEALTH_REPORT}}` token.
3. Implement `buildClassifyPrompt(report: string)`.
4. Reject empty/whitespace reports.
5. Assert the template contains the token and that the generated prompt has no remaining token.

Decision: avoid prompt optimization in this task. The issue requests the first draft prompt and model-swappability, not prompt experimentation.

### Phase 6: OpenRouter client

1. Implement `callOpenRouter()` using global `fetch`.
2. POST to `${OPENROUTER_BASE_URL}/chat/completions`.
3. Include:
   - `Authorization: Bearer ${OPENROUTER_API_KEY}`
   - configured `model`
   - `temperature: 0`
   - `response_format: { type: "json_object" }`
   - prompt as chat message content
4. Enforce timeout with `AbortController`.
5. Return `choices[0].message.content`.
6. Throw `LlmError` for:
   - non-2xx responses, including status and safe body snippet
   - timeout
   - malformed response
   - missing content

Decision: use the OpenRouter HTTP API directly. This avoids vendor SDK lock-in and satisfies the model-swap requirement.

### Phase 7: Classify stage

1. Implement `classifyStage.run(input)`.
2. Flow:
   - fetch report
   - build prompt
   - call OpenRouter
   - strip accidental markdown JSON fences if present
   - `JSON.parse`
   - `parseClassification`
   - return successful `StageResult`
3. On JSON parse or schema-validation failure:
   - perform exactly one repair retry
   - append a short instruction that the previous response was invalid and the model must return valid JSON matching the schema
   - parse and validate the retry response
4. If retry also fails:
   - return a fallback `ClassificationResult`
   - `overall_severity: "NONE"`
   - empty `incidents` and `findings`
   - summary describing classification failure
   - log the failure without throwing out of `run`
5. Do not synthesize incidents from failed classification.

Decision: return a non-actionable fallback on classification failure to keep the monitoring loop alive. The failure itself should be logged, and later stages will not receive invented incident facts.

### Phase 8: Stage stubs

1. Implement `Investigate`, `Mitigate`, `Restore`, and `Verify` as typed stubs.
2. Each returns exactly `{ status: "not_implemented", stage: <stage-name> }`.
3. Do not add business logic for these stages.

### Phase 9: Non-blocking orchestrator

1. Register all five stages.
2. Schedule ticks using `setInterval` or recursive `setTimeout`.
3. Dispatch Classify as an unawaited async task from each tick.
4. Add an in-flight guard for Classify:
   - if a previous Classify run is still active, log a skipped tick
   - do not start overlapping Classify runs from the same loop
5. Catch and log stage errors inside the async task so the loop survives.
6. Expose `stop()` for graceful shutdown and tests.
7. `src/index.ts` should load config, start the orchestrator, and handle `SIGINT`/`SIGTERM`.

Decision: the loop should never await the stage inline. This preserves the required non-blocking scheduler behavior while preventing duplicate Classify runs.

### Phase 10: Tests and validation

Add unit tests with all external calls mocked:

- `classificationSchema.test.ts`
  - accepts the no-incident payload
  - rejects invalid severity
  - rejects invalid classification
  - rejects missing required fields
  - rejects confidence outside `[0, 1]`
- `classifyPrompt.test.ts`
  - substitutes the report
  - leaves no `{{HEALTH_REPORT}}`
  - rejects empty/whitespace input
- `fetchReport.test.ts`
  - returns fixture markdown from mocked S3
  - errors on invalid URI
  - errors on `NoSuchKey`
  - errors on empty body
  - errors on timeout
- `openrouter.test.ts`
  - asserts URL, method, auth header, model, `temperature: 0`, and `response_format`
  - returns message content on success
  - errors on 429/500
  - errors on missing content
  - errors on timeout
- `classify.test.ts`
  - happy path returns no-incident result
  - strips markdown fences
  - retries once on invalid JSON and succeeds if repair is valid
  - retries once and returns fallback if repair is invalid
- `orchestrator.test.ts`
  - fake timers show ticks continue while a long Classify task is in flight
  - overlapping Classify runs are skipped
  - stage rejection is logged and later ticks continue
  - `stop()` prevents further ticks
- `stubs.test.ts`
  - all four non-Classify stages return the exact `not_implemented` marker.
- `config.test.ts`
  - missing `OPENROUTER_API_KEY` throws
  - defaults are applied when optional vars are absent
  - non-numeric intervals/timeouts throw with variable names

Validation commands for coding phase:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Manual verification after implementation:

- Copy `.env.example` to `.env`.
- Set a real `OPENROUTER_API_KEY`.
- Ensure AWS credentials can read `s3://hokusai-health-reports-development/latest/development/report.md`.
- Run `pnpm start` and observe one Classify tick logging a schema-valid `ClassificationResult`.
- Temporarily use a missing S3 key and confirm the loop logs the fetch error and continues.
- Change `OPENROUTER_MODEL` and confirm no code change is needed.
- Confirm no `.env` or secret values are tracked.

## Risks and Mitigations

- OpenRouter may return malformed JSON despite `response_format`.
  - Mitigation: strict parse/validation and one repair retry, then safe fallback.
- The prompt example contains curly quotes.
  - Mitigation: preserve the prompt text, but parse only the model response and validate runtime JSON.
- S3 response bodies can be streams with different runtime shapes.
  - Mitigation: use AWS SDK body transform helpers when available, with a tested stream fallback if needed.
- Non-blocking loop tests can be flaky if they use real timers.
  - Mitigation: use Vitest fake timers and dependency-injected stage implementations for orchestrator tests.
- The repo is greenfield, so package-manager choice may be ambiguous.
  - Mitigation: use `pnpm` per the expanded packet. If unavailable during coding, document any fallback.

## Release Readiness

- `database_change_risk`: `none`
- `env_changes`: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_BASE_URL`, `HEALTH_REPORT_S3_URI`, `AWS_REGION`, `MONITOR_INTERVAL_MS`, `LLM_TIMEOUT_MS`, `S3_TIMEOUT_MS`
- `config_changes`: `package.json`, `tsconfig.json`, `.eslintrc.cjs`, `.env.example`
- `manual_steps`: provide `OPENROUTER_API_KEY`, ensure AWS credentials have read access to `s3://hokusai-health-reports-development/latest/development/report.md`, run `pnpm install` before first run

## Approval Gate

After user approval, create:

```bash
touch features/basic-monitoring-framework-mttr-challenger/.plan-approved
```

Then stop so the orchestrator can launch the coding phase.
