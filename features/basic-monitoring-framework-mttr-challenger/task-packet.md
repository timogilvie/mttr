# Basic Monitoring Framework (MTTR) — Classify Stage - Quick Reference

**Issue ID**: HOK-2082

## Objective

Build the skeleton of a non-blocking, five-stage monitoring agent (Classify → Investigate → Mitigate → Restore → Verify) and fully implement **only the Classify stage**. Classify fetches the latest Hokusai CloudWatch Health Report from S3, builds an LLM prompt embedding the report, calls an LLM via OpenRouter, and returns a validated structured incident-classification JSON object for downstream stages. This enables automated, model-swappable incident triage to reduce MTTR.

## Key Files

- `package.json` (new) — Node/TypeScript project manifest, scripts, deps
- `src/report/fetchReport.ts` (new) — S3 fetch of `report.md` with error handling
- `src/llm/openrouter.ts` (new) — OpenRouter chat-completions client
- `src/stages/classify.ts` (new) — Classify stage implementation + JSON validation
- `src/orchestrator.ts` (new) — non-blocking stage loop scaffold (only Classify wired)

## Critical Constraints

1. **Only the Classify stage is implemented.** Investigate/Mitigate/Restore/Verify exist as no-op typed stubs only; do not implement their logic.
2. **All LLM access goes through OpenRouter** via a configurable model env var (`OPENROUTER_MODEL`) so the model can be swapped without code changes. No direct vendor SDK calls.
3. **Stages must be non-blocking** — the orchestrator must not `await`-block its loop on a long-running incident; Classify runs as a fire-and-forget async task and the loop schedules the next tick on a fixed interval.

## Success Criteria (High-Level)

- [ ] Classify fetches `s3://hokusai-health-reports-development/latest/development/report.md`, builds the prompt, and returns schema-valid JSON
- [ ] Output JSON conforms exactly to the required schema (summary, overall_severity, incidents[], findings[]) and is validated before return
- [ ] OpenRouter model is configurable via env; S3 URI is configurable via env
- [ ] All external calls (S3, OpenRouter) handle timeout/missing/invalid-response failures explicitly
- [ ] Tests and lint pass; PR created and linked to HOK-2082

## Detailed Sections

Full details available on-demand in task-packet-details.md:

- [Section 1: Complete Objective & Scope](#1-objective)
- [Section 2: Technical Context](#2-technical-context)
- [Section 3: Implementation Approach](#3-implementation-approach)
- [Section 4: Success Criteria](#4-success-criteria)
- [Section 5: Implementation Constraints](#5-implementation-constraints)
- [Section 6: Validation Steps](#6-validation-steps)
- [Section 7: Definition of Done](#7-definition-of-done)
- [Section 8: Rollback Plan](#8-rollback-plan)
- [Section 9: Release Readiness](#9-release-readiness)
- [Section 10: Proposed Labels](#10-proposed-labels)

**Implementation Note**: Start with this overview. Read detailed sections on-demand as you implement.

---

## 1. Objective

### What
Implement a non-blocking five-stage monitoring-agent framework and fully build only its first stage (Classify), which consumes the Hokusai CloudWatch Health Report from S3 and returns a validated, structured incident-classification JSON produced by an LLM accessed through OpenRouter.

### Why
The MTTR project aims to automate incident detection and response to reduce Mean Time To Recovery. The Classify stage is the entry point: it converts raw health telemetry into structured incident hypotheses that downstream stages (Investigate/Mitigate/Restore/Verify) will act on. Routing LLM calls through OpenRouter lets the team A/B test and swap models cheaply. Building the framework skeleton now establishes the non-blocking execution contract before later stages are added.

### Scope In
- A runnable Node/TypeScript project at the repository root (this is a greenfield repo — only `LICENSE` and `features/` exist).
- An orchestrator loop that runs on a fixed interval and dispatches stages without blocking on long-running work.
- A typed `Stage` interface and five stage entries; **Classify fully implemented**, the other four as typed no-op stubs that return a "not implemented" marker.
- S3 client to fetch the latest health report markdown.
- OpenRouter LLM client (chat completions) with configurable model.
- A prompt builder that injects the report into the provided "First Draft Classifier Prompt" (replacing `{{HEALTH_REPORT}}`).
- Strict parsing/validation of the LLM JSON response against the required output schema, with one repair retry.
- Unit tests for prompt building, JSON validation, S3 fetch error paths, and OpenRouter error paths (all external calls mocked).
- Environment-based configuration and a `.env.example`.

### Scope Out
- Implementation of Investigate, Mitigate, Restore, or Verify stage logic (stubs only).
- Persisting incidents to a database or creating Linear/PagerDuty tickets.
- Generating the Health Report itself (already produced by an existing GitHub Action — out of scope).
- Deploying/hosting the agent (no Dockerfile, no CI workflow, no infra changes).
- Notifications/alerting, dashboards, or any UI.
- Fine-tuning the prompt content beyond the provided first draft (use it verbatim, parameterized).

---

## 2. Technical Context

### Repository
Single repo, current branch `task/basic-monitoring-framework-mttr-challenger`. The repo is effectively empty (`Initial commit` with `LICENSE`; an untracked `features/` directory). All project scaffolding is new.

### Key Files
All files are **new** (greenfield). Place the project at the repository root.

- `package.json` (new) — manifest with scripts (`build`, `lint`, `typecheck`, `test`, `start`) and dependencies.
- `tsconfig.json` (new) — strict TypeScript config (`"strict": true`).
- `.eslintrc.cjs` (new) — ESLint config (typescript-eslint recommended).
- `.env.example` (new) — documents required env vars (no secrets).
- `src/index.ts` (new) — entry point; loads config, starts orchestrator.
- `src/config.ts` (new) — reads & validates env vars; throws on missing required vars.
- `src/types.ts` (new) — shared types: `ClassificationResult`, `Incident`, `Finding`, `Severity`, `Classification`, `Stage`, `StageResult`.
- `src/orchestrator.ts` (new) — non-blocking interval loop dispatching stages.
- `src/report/fetchReport.ts` (new) — fetch `report.md` from S3 via `@aws-sdk/client-s3`.
- `src/llm/openrouter.ts` (new) — OpenRouter chat-completions client (uses global `fetch`).
- `src/prompts/classifyPrompt.ts` (new) — exported prompt template + `buildClassifyPrompt(report: string)`.
- `src/stages/classify.ts` (new) — Classify stage: fetch → prompt → LLM → validate → return.
- `src/stages/stubs.ts` (new) — Investigate/Mitigate/Restore/Verify no-op stubs.
- `src/validation/classificationSchema.ts` (new) — runtime validation of LLM output (use `zod`).
- `src/__tests__/classifyPrompt.test.ts` (new)
- `src/__tests__/classificationSchema.test.ts` (new)
- `src/__tests__/fetchReport.test.ts` (new)
- `src/__tests__/openrouter.test.ts` (new)
- `src/__tests__/classify.test.ts` (new)
- `test/fixtures/report.md` (new) — copy of the sample health report from the issue for tests.

### Relevant Subsystem Specs
> ⚠️ **Knowledge Gap**: No subsystem specs found for this area (no `.wavemill/context/` provided and the repo has no codebase-context file). This is a new subsystem. After implementation, run `wavemill context init --force` to create subsystem documentation for the monitoring agent and enable persistent downstream acceleration for the remaining four stages.

### Dependencies
- **Runtime**: Node.js ≥ 20 (for global `fetch` and `AbortController`).
- **Packages**: `@aws-sdk/client-s3` (S3 read), `zod` (schema validation). Dev: `typescript`, `tsx` (run TS directly), `vitest`, `eslint`, `@typescript-eslint/*`, `@types/node`.
- **External services**: AWS S3 (bucket `hokusai-health-reports-development`, region `us-east-1`); OpenRouter API (`https://openrouter.ai/api/v1/chat/completions`).
- **Credentials**: AWS credentials available via standard provider chain (env/SSO/instance role); `OPENROUTER_API_KEY`.
- **Upstream**: Health report is produced by an existing GitHub Action (not in this repo).

### Architecture Notes
- **Package manager**: Use `pnpm` (validation commands assume it). If `pnpm` is unavailable, the agent may fall back to `npm` and document the substitution in the PR.
- **Non-blocking contract**: The orchestrator uses `setInterval` (or a recursive `setTimeout`) at `MONITOR_INTERVAL_MS`. Each tick invokes Classify as an unawaited async task; a per-stage in-flight guard prevents overlapping Classify runs from the same loop, while still allowing the loop itself to keep ticking. This models "incidents that run independently for longer periods" without blocking the loop.
- **Stage interface**: `interface Stage { name: string; run(input: StageInput): Promise<StageResult>; }`. Stubs return `{ status: 'not_implemented', stage: <name> }`.
- **Config-first**: All endpoints, model name, S3 URI, timeouts, and interval come from env via `src/config.ts`. No hardcoded secrets.
- **LLM determinism**: Request OpenRouter with `temperature: 0` and `response_format: { type: 'json_object' }` to maximize valid-JSON output. Always validate regardless.
- **Prompt fidelity**: Use the issue's "First Draft Classifier Prompt" verbatim as the system/user content, substituting `{{HEALTH_REPORT}}` with the fetched markdown. Note the prompt contains "smart quotes" (`"` `"`) in the JSON example — store the prompt as a plain template string exactly as provided; do **not** rely on those curly quotes for parsing (we parse the model's reply, not the prompt example).

---

## 3. Implementation Approach

1. **Scaffold the project** — create `package.json`, `tsconfig.json` (`strict`, `moduleResolution: bundler`/`node16`, `outDir: dist`), `.eslintrc.cjs`, and `.gitignore` (ignore `node_modules`, `dist`, `.env`). Add scripts: `build` (`tsc`), `typecheck` (`tsc --noEmit`), `lint` (`eslint .`), `test` (`vitest run`), `start` (`tsx src/index.ts`). Install deps listed in Section 2.
2. **Define shared types** (`src/types.ts`) — enums/unions for `Severity` (`NONE|LOW|MEDIUM|HIGH|CRITICAL`) and `Classification` (the 17 taxonomy values), plus `Incident`, `Finding`, `ClassificationResult`, `Stage`, `StageInput`, `StageResult`. These mirror the required output schema.
3. **Build the validation schema** (`src/validation/classificationSchema.ts`) — a `zod` schema matching the required JSON exactly (incidents/findings arrays, nested `signals` and `investigation_plan`, confidence as number 0–1, severity/classification enums). Export `parseClassification(raw: unknown): ClassificationResult` that throws a typed `ClassificationValidationError` on mismatch.
4. **Config loader** (`src/config.ts`) — read and validate env: `OPENROUTER_API_KEY` (required), `OPENROUTER_MODEL` (default `openai/gpt-4o-mini`), `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`), `HEALTH_REPORT_S3_URI` (default `s3://hokusai-health-reports-development/latest/development/report.md`), `AWS_REGION` (default `us-east-1`), `MONITOR_INTERVAL_MS` (default `300000`), `LLM_TIMEOUT_MS` (default `60000`), `S3_TIMEOUT_MS` (default `15000`). Throw a clear error naming any missing required var.
5. **S3 fetch** (`src/report/fetchReport.ts`) — parse the `s3://bucket/key` URI, use `@aws-sdk/client-s3` `GetObjectCommand`, enforce a timeout via `AbortController`. Convert the body stream to a UTF-8 string. Throw `ReportFetchError` with cause on: invalid URI, `NoSuchKey`, empty body, timeout, or auth failure.
6. **Prompt builder** (`src/prompts/classifyPrompt.ts`) — export `CLASSIFY_PROMPT_TEMPLATE` (the issue's first-draft prompt) and `buildClassifyPrompt(report: string): string` that replaces the single `{{HEALTH_REPORT}}` token. Throw if the token is absent or `report` is empty.
7. **OpenRouter client** (`src/llm/openrouter.ts`) — `callOpenRouter({ model, prompt, timeoutMs })` POSTs to `${baseUrl}/chat/completions` with `Authorization: Bearer`, `temperature: 0`, `response_format: { type: 'json_object' }`, and the prompt as a single user message. Enforce timeout via `AbortController`. Throw `LlmError` on non-2xx (include status + body), timeout, or missing `choices[0].message.content`. Return the raw content string.
8. **Classify stage** (`src/stages/classify.ts`) — orchestrates: `fetchReport()` → `buildClassifyPrompt()` → `callOpenRouter()` → strip any accidental markdown fences → `JSON.parse` → `parseClassification()`. On JSON parse/validation failure, perform **one** repair retry: re-call OpenRouter appending an instruction to "return valid JSON only matching the schema; previous response was invalid." If the retry also fails, return a synthesized fallback `ClassificationResult` with `overall_severity: "NONE"`, empty arrays, and `summary` describing the classification failure, plus log the error. Return a `StageResult`.
9. **Stage stubs** (`src/stages/stubs.ts`) — Investigate/Mitigate/Restore/Verify each implement `Stage` and return `{ status: 'not_implemented', stage }`.
10. **Orchestrator** (`src/orchestrator.ts`) — `startOrchestrator(config)` registers the five stages, runs Classify on each interval tick as an unawaited task guarded by an in-flight flag (skip the tick if a Classify run is still in progress, logging a "skipped: previous run in flight" message). Expose `stop()` to clear the interval (used by tests). Loop must never `await` a stage run inline.
11. **Entry point** (`src/index.ts`) — load config, call `startOrchestrator`, handle `SIGINT`/`SIGTERM` to stop gracefully.
12. **Tests & fixtures** — add `test/fixtures/report.md` (the sample report) and unit tests per Section 6 with S3 and OpenRouter fully mocked. No real network calls in tests.
13. **Docs** — `.env.example` and a short `README.md` section: prerequisites, env vars, `pnpm start`, and that only Classify is implemented.

---

## 4. Success Criteria

### Functional Requirements

- [ ] **[REQ-F1]** `fetchReport()` retrieves the markdown body from a configured `s3://bucket/key` URI and returns it as a non-empty UTF-8 string; on `NoSuchKey`, invalid URI, empty body, timeout, or auth error it throws `ReportFetchError` whose message names the failing URI and underlying cause.
- [ ] **[REQ-F2]** `buildClassifyPrompt(report)` returns the first-draft prompt with the single `{{HEALTH_REPORT}}` token replaced by `report`; it throws if `report` is empty/whitespace or if the template lacks the token. The returned string contains no remaining `{{HEALTH_REPORT}}` substring.
- [ ] **[REQ-F3]** `callOpenRouter()` POSTs to `${OPENROUTER_BASE_URL}/chat/completions` with the configured `OPENROUTER_MODEL`, `temperature: 0`, `response_format: { type: 'json_object' }`, and `Authorization: Bearer ${OPENROUTER_API_KEY}`; returns `choices[0].message.content`. On non-2xx, timeout (> `LLM_TIMEOUT_MS`), or missing content it throws `LlmError` including the HTTP status (or `timeout`) and response body snippet.
- [ ] **[REQ-F4]** `parseClassification(raw)` accepts only objects matching the required schema (top-level `summary:string`, `overall_severity` ∈ the 5 severities, `incidents:[]`, `findings:[]` with all nested required fields and `confidence` a number in `[0,1]`); valid input returns a typed `ClassificationResult`, invalid input throws `ClassificationValidationError` naming the first offending field/path.
- [ ] **[REQ-F5]** The Classify stage end-to-end (mocked S3 + mocked OpenRouter returning the issue's "no incidents" payload) returns a `StageResult` whose `result.summary === "No actionable incidents detected."`, `overall_severity === "NONE"`, and empty `incidents`/`findings` arrays.
- [ ] **[REQ-F6]** When OpenRouter returns invalid JSON twice (initial + repair retry), the Classify stage returns a fallback `ClassificationResult` with `overall_severity: "NONE"`, empty `incidents`/`findings`, a `summary` containing the word "classification" and indicating failure, and logs the error; it does **not** throw out of `classify.run()`.
- [ ] **[REQ-F7]** The orchestrator runs Classify on a fixed `MONITOR_INTERVAL_MS` interval without blocking: a long-running (e.g., 2s in test) Classify run does not delay the next scheduled tick, and overlapping runs are prevented by the in-flight guard (a tick during an in-flight run is skipped and logged).
- [ ] **[REQ-F8]** The four non-Classify stages return `{ status: 'not_implemented', stage: <name> }` and contain no business logic.
- [ ] **[REQ-F9]** `config.ts` throws on startup with a message naming the missing variable when `OPENROUTER_API_KEY` is absent; all other vars fall back to documented defaults.

### Non-Functional Requirements
- [ ] LLM and S3 calls each enforce their configured timeout via `AbortController` (no unbounded hangs).
- [ ] No secrets are committed; `.env` is git-ignored and only `.env.example` (no values) is tracked.
- [ ] Model is swappable purely via `OPENROUTER_MODEL` with zero code changes.

### Code Quality
- [ ] Follows existing codebase patterns (none exist; establish clean, consistent module conventions).
- [ ] TypeScript types are correct, `strict` enabled, no `any` (use `unknown` + zod at boundaries).
- [ ] No lint errors.

---

## 5. Implementation Constraints

- **Code style**: TypeScript `strict: true`; ESM modules; no `any` (use `unknown` and validate). One concern per module; named exports. Match formatting via ESLint (no Prettier conflicts).
- **Testing**: Use Vitest. All S3 and OpenRouter interactions must be mocked — **no real network or AWS calls in tests**. Use `test/fixtures/report.md` for report input. Each functional requirement REQ-F1…F9 must have ≥1 corresponding test.
- **Security**: Never log `OPENROUTER_API_KEY` or full request headers. Do not commit `.env`. Read credentials only from env/AWS provider chain. Do not echo full LLM responses containing the report into persistent logs beyond what's needed for debugging.
- **Performance**: Default `MONITOR_INTERVAL_MS = 300000` (5 min); LLM timeout default 60s; S3 timeout default 15s. Orchestrator loop must remain non-blocking (no inline `await` of stage runs).
- **Backwards compatibility**: Greenfield — none required, but the `Stage` interface must be stable enough that the four stub stages can later be implemented without changing the interface signature.
- **Scope discipline**: Do not implement Investigate/Mitigate/Restore/Verify logic. Do not add persistence, ticketing, notifications, Docker, or CI in this task.

---

## 6. Validation Steps

### Functional Requirement Validation

**[REQ-F1] S3 report fetch with error handling**
1. Setup: Mock `@aws-sdk/client-s3` `S3Client.send`. Configure URI `s3://hokusai-health-reports-development/latest/development/report.md`.
2. Action: Call `fetchReport(uri)` with the mock returning a stream of `test/fixtures/report.md`.
3. Expected result: Returns the exact markdown string (starts with `# Hokusai Service Health Report`), length > 0.
4. Edge cases:
   - Mock throws `NoSuchKey` → `fetchReport` throws `ReportFetchError` whose message contains the URI and "NoSuchKey".
   - Mock returns empty body → throws `ReportFetchError` with message containing "empty".
   - URI `https://not-s3/x` → throws `ReportFetchError` with message containing "invalid S3 URI".
   - Mock never resolves and `S3_TIMEOUT_MS=50` → throws `ReportFetchError` with message containing "timeout" within ~100ms.

**[REQ-F2] Prompt builder token substitution**
1. Setup: Import `buildClassifyPrompt` and the sample report string.
2. Action: `const p = buildClassifyPrompt(report)`.
3. Expected result: `p.includes("{{HEALTH_REPORT}}") === false`; `p.includes("# Hokusai Service Health Report") === true`; `p.startsWith("You are the Classify stage")` is true.
4. Edge cases:
   - `buildClassifyPrompt("")` → throws Error with message containing "empty".
   - `buildClassifyPrompt("   ")` (whitespace) → throws Error containing "empty".

**[REQ-F3] OpenRouter client request/response**
1. Setup: Mock global `fetch`. Config `OPENROUTER_MODEL=openai/gpt-4o-mini`, `OPENROUTER_API_KEY=sk-test`.
2. Action: `await callOpenRouter({ model, prompt: "hi", timeoutMs: 1000 })` with mock returning `200` and body `{ choices: [{ message: { content: '{"summary":"x"}' } }] }`.
3. Expected result: Returns the string `{"summary":"x"}`. Asserts the `fetch` call used URL ending `/chat/completions`, method `POST`, header `Authorization: Bearer sk-test`, and body containing `"temperature":0` and `"response_format":{"type":"json_object"}` and `"model":"openai/gpt-4o-mini"`.
4. Edge cases:
   - Mock returns `429` with body `{"error":"rate"}` → throws `LlmError` containing "429".
   - Mock returns `200` with `{ choices: [] }` → throws `LlmError` containing "no content".
   - Mock delays beyond `timeoutMs=20` → throws `LlmError` containing "timeout".

**[REQ-F4] Classification schema validation**
1. Setup: Import `parseClassification`.
2. Action: Pass the issue's "no incidents" object `{ summary: "No actionable incidents detected.", overall_severity: "NONE", incidents: [], findings: [] }`.
3. Expected result: Returns a `ClassificationResult` equal to input (typed).
4. Edge cases:
   - `overall_severity: "BROKEN"` → throws `ClassificationValidationError` naming `overall_severity`.
   - An incident with `confidence: 1.7` → throws `ClassificationValidationError` naming `confidence` (out of `[0,1]`).
   - Missing `findings` key → throws `ClassificationValidationError` naming `findings`.
   - An incident with `classification: "FOO"` → throws naming `classification`.

**[REQ-F5] Classify happy path (no incidents)**
1. Setup: Mock `fetchReport` → fixture; mock `callOpenRouter` → the issue's exact "no incidents" JSON string.
2. Action: `await classifyStage.run({ config })`.
3. Expected result: `StageResult.status === 'ok'`; `result.summary === "No actionable incidents detected."`; `result.overall_severity === "NONE"`; `result.incidents.length === 0`; `result.findings.length === 0`.
4. Edge cases:
   - OpenRouter returns JSON wrapped in ```json fences → stage strips fences, still parses successfully.
   - OpenRouter returns a valid result with one MEDIUM incident → `result.incidents.length === 1` and `overall_severity` preserved as returned.

**[REQ-F6] Classify repair retry + fallback**
1. Setup: Mock `fetchReport` → fixture; mock `callOpenRouter` to return `"not json"` on first call and `"still not json"` on second call.
2. Action: `await classifyStage.run({ config })`.
3. Expected result: `callOpenRouter` called exactly twice; `run` resolves (does not throw); `result.overall_severity === "NONE"`; `result.incidents` and `result.findings` are `[]`; `result.summary` contains "classification" (failure marker); an error is logged.
4. Edge cases:
   - First call invalid JSON, second call valid schema JSON → `run` returns the second (valid) result; exactly two calls made.
   - First call valid JSON → only one call made (no retry).

**[REQ-F7] Non-blocking orchestrator loop**
1. Setup: Use fake timers (Vitest `vi.useFakeTimers()`). Replace Classify with a stub that resolves after a simulated 2000ms. `MONITOR_INTERVAL_MS=1000`.
2. Action: `startOrchestrator(config)`; advance timers by 3000ms.
3. Expected result: The interval fired ≥3 times (loop not blocked by the 2s run); the in-flight guard caused ticks during an active run to be skipped (skip logged); at most one Classify run active at any moment.
4. Edge cases:
   - Classify run rejects (throws) → orchestrator logs the error and the next tick still fires (loop survives).
   - `stop()` called → no further ticks fire after advancing timers.

**[REQ-F8] Stage stubs**
1. Setup: Import the four stub stages.
2. Action: `await investigateStage.run(input)` (and the other three).
3. Expected result: Each returns `{ status: 'not_implemented', stage: <name> }` where `<name>` is `Investigate`/`Mitigate`/`Restore`/`Verify`.
4. Edge cases:
   - Called with empty input `{}` → still returns the not_implemented marker (no throw).
   - Marker `status` value is exactly `'not_implemented'`.

**[REQ-F9] Config validation**
1. Setup: Clear `OPENROUTER_API_KEY` from env.
2. Action: `loadConfig()`.
3. Expected result: Throws Error with message containing `OPENROUTER_API_KEY`.
4. Edge cases:
   - All vars unset except `OPENROUTER_API_KEY` → returns config with documented defaults (`OPENROUTER_MODEL=openai/gpt-4o-mini`, `AWS_REGION=us-east-1`, `MONITOR_INTERVAL_MS=300000`, default S3 URI).
   - `MONITOR_INTERVAL_MS=abc` (non-numeric) → throws Error naming `MONITOR_INTERVAL_MS`.

---

### Input/Output Verification

**Valid Inputs:**
- Input: sample `report.md` + mocked LLM "no incidents" reply → Expected: `ClassificationResult` `{ summary: "No actionable incidents detected.", overall_severity: "NONE", incidents: [], findings: [] }`.
- Input: LLM reply with one incident `classification: "OBSERVABILITY_FAILURE"`, `severity: "LOW"`, `confidence: 0.4` → Expected: parsed result with that incident preserved (note: confidence-based finding-vs-incident decision is the model's responsibility per prompt, not ours).
- Input: env with only `OPENROUTER_API_KEY` set → Expected: config object with all documented defaults.

**Invalid Inputs:**
- Input: LLM reply `"not json"` (twice) → Expected: fallback `ClassificationResult` (NONE, empty arrays), no throw, error logged.
- Input: S3 `GetObject` raising `NoSuchKey` → Expected: `ReportFetchError` naming the URI.
- Input: OpenRouter HTTP `500` → Expected: `LlmError` containing "500".
- Input: classification object with `incidents` not an array → Expected: `ClassificationValidationError` naming `incidents`.

---

### Standard Validation Commands

```bash
# 1. Lint passes
pnpm lint
# Expected: no errors

# 2. Type check passes
pnpm typecheck
# Expected: no type errors

# 3. Tests pass
pnpm test
# Expected: all tests pass (REQ-F1..F9 covered)

# 4. Build succeeds
pnpm build
# Expected: dist/ produced, no build errors
```

---

### Manual Verification Checklist

- [ ] Copy `.env.example` to `.env`, set a real `OPENROUTER_API_KEY` and valid AWS credentials, run `pnpm start`; observe one Classify tick that fetches the real S3 report and prints a schema-valid `ClassificationResult` (verify `overall_severity` is one of the 5 allowed values).
- [ ] Temporarily set `HEALTH_REPORT_S3_URI` to a non-existent key; confirm the stage logs a `ReportFetchError` naming the URI and the loop continues (does not crash).
- [ ] Set `OPENROUTER_MODEL` to a different model (e.g., `anthropic/claude-3.5-haiku`) and confirm the request uses it (no code change needed); response still validates.
- [ ] Grep the repo to confirm `.env` is not tracked and no API key string is committed.

---

## 7. Definition of Done

- [ ] All success criteria (REQ-F1…F9 + non-functional) met.
- [ ] All validation steps pass with specific, measurable outcomes.
- [ ] Each functional requirement has at least one concrete validation scenario (it does).
- [ ] Edge cases documented and tested.
- [ ] Only Classify implemented; other four stages are stubs.
- [ ] No unrelated changes included.
- [ ] Commit message references `HOK-2082`.
- [ ] PR created with a clear description linking to the Linear issue.

---

## 8. Rollback Plan

- This is additive, greenfield work with no runtime deployment in scope, so rollback is low-risk.
- Revert the feature commit(s): `git revert <sha>` (or delete the branch before merge).
- No database migrations to roll back.
- No feature flag required; the agent is not yet deployed/scheduled anywhere by this task.
- If the orchestrator is ever started in an environment, stop it via `SIGINT`/`SIGTERM` (graceful `stop()`); removing the process fully halts all activity since there is no persisted state.

---

## 9. Release Readiness

- **database_change_risk**: none
- **env_changes**: OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_BASE_URL, HEALTH_REPORT_S3_URI, AWS_REGION, MONITOR_INTERVAL_MS, LLM_TIMEOUT_MS, S3_TIMEOUT_MS
- **config_changes**: package.json, tsconfig.json, .eslintrc.cjs, .env.example
- **manual_steps**: Provide OPENROUTER_API_KEY secret, ensure AWS credentials with read access to s3://hokusai-health-reports-development, run pnpm install before first run

---

## 10. Proposed Labels

**Risk Level** (Required):

**Selected**: `Risk: Medium`

**Justification**: New, self-contained subsystem with external integrations (S3, OpenRouter) and async orchestration, but no breaking changes, no database, and not yet wired into deployment. Medium fits a new feature with state/async behavior and no breaking changes.

---

**Files to Modify** (Auto-detected):
- `src/stages/classify.ts`
- `src/llm/openrouter.ts`
- `src/report/fetchReport.ts`
- `src/orchestrator.ts`
- `src/validation/classificationSchema.ts`

**Label**: `Files: classify.ts, openrouter.ts, fetchReport.ts, orchestrator.ts, classificationSchema.ts`

**Purpose**: Prevents parallel tasks from modifying the same files.

---

**Architectural Layer** (Recommended):

**Selected**: `Layer: Service`

**Purpose**: Backend business logic / integration code; can run in parallel with UI/Database tasks.

---

**Area** (Recommended):

**Selected**: `Area: Monitoring`

**Purpose**: Avoid running another task touching the MTTR monitoring agent concurrently.

---

**Test Coverage** (Auto-detected):

**Selected**: `Tests: Unit`

**Purpose**: Unit tests (Vitest) with mocked S3/OpenRouter; can run in parallel with other unit-test tasks.

---

**Component** (Optional):

**Selected**: `Component: ClassifyStage`

**Purpose**: Avoid concurrent edits to the Classify stage.

---

### Label Summary

```
Suggested labels for this task:
- Risk: Medium
- Files: classify.ts, openrouter.ts, fetchReport.ts, orchestrator.ts, classificationSchema.ts
- Layer: Service
- Area: Monitoring
- Tests: Unit
- Component: ClassifyStage
```

**How these labels help the autonomous workflow:**
- **Risk: Medium** — Max 2 Medium-risk tasks run in parallel.
- **Files: ...** — Prevents file conflicts with other tasks.
- **Layer: Service** — Can run in parallel with UI/Database/Infra tasks.
- **Area: Monitoring** — Prevents conflicts with other monitoring-agent tasks (e.g., future Investigate stage).
- **Tests: Unit** — Can run in parallel with other unit-test tasks.
- **Component: ClassifyStage** — Prevents concurrent edits to the Classify stage.