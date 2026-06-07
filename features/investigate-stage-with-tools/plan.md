# Investigate Stage with Read-Only Tools

Implementation plan for Stage 2 (`Investigate`) of the Hokusai Monitoring Agent, with a
minimal agentic tool loop and two read-only AWS evidence-gathering tools. Scope corresponds
to the "~2.5–3x" tier: build the tool loop + safety harness once, wire in CloudWatch Logs
Insights and CloudWatch metrics/alarm-history, and leave ECS/ELB as future increments.

## Goal

Replace the `Investigate` no-op stub with a real stage that:

1. Consumes the validated `ClassificationResult` from Stage 1.
2. Reasons over each incident/finding and gathers supporting evidence from AWS via a bounded
   tool loop (read-only).
3. Returns a schema-validated `InvestigationResult` that gives the future `Mitigate` stage a
   stable identifier per item, a confidence-gated status, candidate root causes, and an
   explicit "ready for mitigation vs. blocked on evidence" signal.

Non-goals: no remediation, no mutating AWS calls, no ECS/ELB/deploy-history tools yet, no
persistence.

## Codebase Research Summary

Current state (verified against `main`):

- Stage 1 is fully implemented and is the pattern to mirror:
  - `src/prompts/classifyPrompt.ts` — template + `{{HEALTH_REPORT}}` substitution + `PromptBuildError`.
  - `src/validation/classificationSchema.ts` — Zod schema, `parseClassification`, `ClassificationValidationError` that surfaces the first failing path.
  - `src/stages/classify.ts` — fetch → build prompt → call LLM → strip fences → parse/validate → **one repair retry** → safe fallback. Never throws out of `run`.
  - `src/llm/openrouter.ts` — **single-shot** `callOpenRouter` (one user message → content string). `temperature: 0`, `response_format: { type: 'json_object' }`, `AbortController` timeout, `LlmError`.
  - `src/report/fetchReport.ts` — the shape every AWS wrapper should copy: parse input, construct SDK v3 client, `AbortController` timeout, typed error class, `client.destroy()` in `finally`.
- `src/orchestrator.ts` runs **only** Classify on the loop. `investigateStage` in `src/stages/stubs.ts` exists but is never called. Stage chaining does not exist yet.
- `src/types.ts` — `StageResult.data` is `ClassificationResult | { message: string }`; must be widened.
- `src/config.ts` — single `OPENROUTER_MODEL` for all stages; `aws.region` already present; only S3 timeout configured.
- Dependencies: only `@aws-sdk/client-s3` and `zod`. No CloudWatch SDK clients installed.
- Tests use Vitest with all external services mocked (`src/__tests__/*`).

Implication: the dominant new cost is the agentic loop + safety harness (paid once). Each AWS
tool after that is an incremental `fetchReport`-shaped wrapper.

## Recommended Architecture

Keep `callOpenRouter` untouched (Classify keeps its cheap single-shot path). Add a separate
multi-turn loop module so the two call styles stay isolated.

New / changed modules:

- `src/llm/toolLoop.ts` (new) — `callOpenRouterWithTools(...)`: OpenAI-compatible tool loop.
- `src/tools/types.ts` (new) — `ToolDefinition` interface (LLM JSON schema + Zod arg schema + handler).
- `src/tools/registry.ts` (new) — assembles the active tool set, dispatches calls, enforces the safety harness.
- `src/tools/cloudwatchLogs.ts` (new) — Logs Insights query tool (read-only).
- `src/tools/cloudwatchMetrics.ts` (new) — metric statistics + alarm history tool (read-only).
- `src/prompts/investigatePrompt.ts` (new) — template + `{{STEP_1_JSON}}` substitution.
- `src/validation/investigationSchema.ts` (new) — Zod schema + `parseInvestigation`.
- `src/stages/investigate.ts` (new) — stage orchestration mirroring `classify.ts`.
- `src/types.ts` (change) — add investigation types; widen `StageResult.data`.
- `src/config.ts` (change) — per-stage model, tool budget/limits, CloudWatch timeout.
- `src/orchestrator.ts` (change) — chain Classify → Investigate.
- `src/stages/stubs.ts` (change) — remove `investigateStage`; keep the other three.
- `.env.example`, `README.md` (change) — new env vars, IAM notes.
- New deps: `@aws-sdk/client-cloudwatch-logs`, `@aws-sdk/client-cloudwatch`.

## Implementation Plan

### Phase 1: Shared contracts and investigation schema

1. In `src/types.ts` add:
   - `OverallAssessment = 'ACTIVE_INCIDENT' | 'POSSIBLE_INCIDENT' | 'OBSERVABILITY_ISSUE' | 'NO_ACTIONABLE_INCIDENT' | 'INSUFFICIENT_EVIDENCE'`.
   - `InvestigationStatus = 'CONFIRMED_INCIDENT' | 'POSSIBLE_INCIDENT' | 'LIKELY_NON_INCIDENT' | 'OBSERVABILITY_GAP' | 'INSUFFICIENT_EVIDENCE'`.
   - `LikelyCause`, `AdditionalDataNeeded`, `NextInvestigationStep`, `PriorityItem`, `Investigation`, `InvestigationResult` interfaces matching the output schema in Phase 6.
   - Reuse existing `Severity` and `IncidentClassification`.
   - Widen `StageResult['data']` to `ClassificationResult | InvestigationResult | { message: string }`.
2. Implement `src/validation/investigationSchema.ts` with Zod, mirroring `classificationSchema.ts`:
   - `confidence` constrained to `[0, 1]` everywhere it appears.
   - `original_classification` constrained to the existing `IncidentClassification` enum.
   - `severity`/`overall_severity` use the existing `Severity` enum.
   - `InvestigationValidationError` reporting the first failing path.
   - Export `parseInvestigation(data: unknown): InvestigationResult`.

Decision: validate at the LLM boundary with `unknown` input, identical to Stage 1, so
`Mitigate` always receives a typed, predictable object.

### Phase 2: Configuration changes

1. Add per-stage model so Investigate can use a stronger, tool-capable model:
   - `INVESTIGATE_MODEL` (default: `openai/gpt-5.4`). Must support function/tool calling.
   - `INVESTIGATE_MODEL_FALLBACK` (default: `anthropic/claude-3.5-sonnet`) — used when the
     primary model errors in a way that suggests it is unavailable or does not support tools
     (e.g. repeated non-retryable 4xx referencing the model, or a tools-unsupported error).
     The fallback is attempted once per stage run; if it also fails, the stage returns its safe
     fallback `InvestigationResult`. Both fall back to `OPENROUTER_MODEL` only if explicitly unset.
2. Add tool-loop budget/limits:
   - `INVESTIGATE_MAX_TOOL_ITERATIONS` (default 6) — max assistant↔tool turns.
   - `INVESTIGATE_MAX_TOOL_CALLS` (default 12) — **global** cap on total tool calls across the
     whole run (one turn may request several calls; this bounds the sum, not just turns).
   - `TOOL_MAX_CONCURRENCY` (default 2) — max tool calls executed in parallel within one turn.
   - `TOOL_TIMEOUT_MS` (default 20000) — per individual tool call.
   - `TOOL_RESULT_MAX_CHARS` (default 8000) — truncation cap per tool result.
   - `TOOL_DEFAULT_LOOKBACK_MINUTES` (default 60) and `TOOL_MAX_LOOKBACK_MINUTES` (default 1440) — query-window clamps.
   - `INVESTIGATE_LLM_TIMEOUT_MS` (default 120000) — whole-loop budget (longer than single-shot `LLM_TIMEOUT_MS`).
3. Add rate-limit / backoff controls (see Phase 5b):
   - `OPENROUTER_MAX_RETRIES` (default 4) — retries on 429/5xx from OpenRouter.
   - `OPENROUTER_BACKOFF_BASE_MS` (default 1000) and `OPENROUTER_BACKOFF_MAX_MS` (default 30000).
   - `AWS_MAX_ATTEMPTS` (default 5) — passed to every AWS SDK client with `retryMode: 'adaptive'`.
   - `INVESTIGATE_CONSECUTIVE_FAILURE_LIMIT` (default 3) — circuit-breaker trip threshold.
4. Extend `Config` interface accordingly; keep `getEnv`/`getEnvNumber` validation conventions.

Decision: a separate Investigate model + explicit budgets keep the change configurable and
prevent runaway loops/cost without code edits.

### Phase 3: Tool infrastructure (the one-time fixed cost)

1. `src/tools/types.ts`:
   ```ts
   export interface ToolContext { region: string; timeoutMs: number; maxResultChars: number;
     defaultLookbackMinutes: number; maxLookbackMinutes: number; }
   export interface ToolDefinition<A = unknown> {
     name: string;
     description: string;            // shown to the LLM
     parametersJsonSchema: object;   // OpenAI-compatible function parameters
     argsSchema: ZodType<A>;         // runtime validation of model-supplied args
     handler: (args: A, ctx: ToolContext) => Promise<string>; // returns text for the model
   }
   ```
2. `src/tools/registry.ts`:
   - `getTools(): ToolDefinition[]` returns the active set.
   - `toOpenAITools()` maps definitions to the `tools` request payload (`type: 'function'`).
   - `dispatchToolCall(name, rawArgsJson, ctx)`:
     - look up the tool; unknown name → return an error string to the model (never throw).
     - `JSON.parse` args defensively; Zod-validate via `argsSchema`; on failure return a
       descriptive error string so the model can correct itself.
     - clamp time windows to `[*, maxLookbackMinutes]`; default missing windows.
     - run `handler` under its own timeout; truncate the result to `maxResultChars` with a
       `…[truncated]` marker.
     - catch all handler errors and return them as a tool-result string (the loop must
       continue, not crash).

Decision: tool errors are **data returned to the model**, not exceptions. This is what lets
the investigator reason about missing telemetry instead of failing the stage. Read-only is
enforced structurally: only read-only SDK commands are imported anywhere under `src/tools/`.

### Phase 4: Read-only AWS tools

1. `src/tools/cloudwatchLogs.ts` — `query_logs`:
   - Wraps `@aws-sdk/client-cloudwatch-logs` `StartQuery` + poll `GetQueryResults` (or
     `FilterLogEvents` for a simpler v1 — see decision).
   - Args: `log_group` (string, required), `filter_or_query` (string), `lookback_minutes` (number, optional), `limit` (number, optional, capped).
   - Returns compact text rows (timestamp + message), truncated by the harness.
   - `fetchReport.ts`-shaped: client construct, `AbortController`, typed errors, `destroy()`.
2. `src/tools/cloudwatchMetrics.ts` — `get_metrics_and_alarms`:
   - Wraps `@aws-sdk/client-cloudwatch`: `GetMetricStatistics`/`GetMetricData` for a named
     metric, and `DescribeAlarmHistory`/`DescribeAlarms` for alarm state history.
   - Args: `namespace`, `metric_name`, `dimensions` (k/v list), `stat`, `lookback_minutes`, plus optional `alarm_name` for history.
   - Returns datapoints + alarm state transitions as compact text.
3. Both tools take a `ToolContext` and never accept raw AWS credentials in args (credentials
   come from the standard AWS provider chain / environment, like `fetchReport`).

Decision: start with these two because they cover the concrete evidence the example output
needed — 4xx status-code breakdown (Logs Insights) and alarm state history (CloudWatch). ECS
task health and ELB target health are deferred; the registry makes them additive.

Confirmed: use **Logs Insights** (`StartQuery` + poll `GetQueryResults`, with `StopQuery` on
timeout), since the headline use case ("break down 60 4xx by status code") is an aggregation
that `FilterLogEvents` cannot do. The poll loop is bounded by `TOOL_TIMEOUT_MS` and calls
`StopQuery` when the deadline is hit.

Both AWS clients are constructed with `{ maxAttempts: AWS_MAX_ATTEMPTS, retryMode: 'adaptive' }`
so SDK-level throttling backoff is active (see Phase 5b).

### Phase 5: Agentic tool loop

1. `src/llm/toolLoop.ts` — `callOpenRouterWithTools(opts)`:
   - Maintains a `messages` array seeded with the system/user prompt.
   - Each turn POSTs `{ model, messages, tools, temperature: 0 }` to `${baseUrl}/chat/completions`.
   - Note: do **not** set `response_format: json_object` while `tools` are offered (several
     providers reject json-mode + tool_calls together). Strict JSON is enforced on the final
     answer via prompt + fence-strip + Zod + repair retry (Phase 7), matching Stage 1's
     existing tolerance.
   - If the response message contains `tool_calls`: append the assistant message, dispatch
     each call via the registry, append one `role: 'tool'` message per call (with
     `tool_call_id`), and loop.
   - If no `tool_calls`: return `message.content` (the final answer) plus a transcript summary.
   - Enforce `maxIterations`; if exceeded, send one final turn instructing the model to answer
     now with no further tools, then return whatever content comes back.
   - Whole-loop `AbortController` on `INVESTIGATE_LLM_TIMEOUT_MS`; per-call timeout already in
     the harness. Reuse/extend `LlmError`.
2. Keep `callOpenRouter` (single-shot) unchanged for Classify.

Decision: a dedicated loop module isolates the multi-turn complexity and leaves the proven
Stage 1 path untouched. The iteration cap + dual timeouts are the runaway-cost backstop.

### Phase 5b: Rate limiting, backoff, and circuit breaking

This is the "the agent can't loop out of control" guarantee. Four independent layers, so no
single failure mode produces an unbounded loop or runaway cost:

1. **OpenRouter (LLM) 429/5xx backoff** — in `toolLoop.ts` (helper shared with `openrouter.ts`):
   on HTTP 429 or 5xx, retry up to `OPENROUTER_MAX_RETRIES` with exponential backoff + jitter,
   honouring the `Retry-After` header when present, capped at `OPENROUTER_BACKOFF_MAX_MS`. When
   retries are exhausted, throw `LlmError` → stage fallback. Non-retryable 4xx are not retried.
2. **AWS throttling backoff** — every CloudWatch/Logs client is constructed with
   `{ maxAttempts: AWS_MAX_ATTEMPTS, retryMode: 'adaptive' }`. SDK v3's adaptive retryer handles
   `ThrottlingException` / `TooManyRequestsException` with token-bucket backoff; we just enable
   it. Throttles that survive retries become a tool-error string (the loop continues, records a
   telemetry gap).
3. **Hard per-run budgets** (the loop ceiling) — the loop stops issuing tool calls when ANY of:
   `INVESTIGATE_MAX_TOOL_ITERATIONS` turns reached, `INVESTIGATE_MAX_TOOL_CALLS` total calls
   reached, or the `INVESTIGATE_LLM_TIMEOUT_MS` whole-loop deadline passed. On stop it issues one
   final forced-answer turn (no tools offered). `TOOL_MAX_CONCURRENCY` bounds parallel calls per turn.
4. **Circuit breaker** — track consecutive failed tool calls and consecutive LLM retries; if
   either hits `INVESTIGATE_CONSECUTIVE_FAILURE_LIMIT`, abort the loop immediately, return the
   safe fallback `InvestigationResult`, and log the trip. A wedged dependency can't burn the full
   budget on guaranteed failures.

Outer guarantees reinforce this: the orchestrator `intervalMs` (default 300s) plus the
`investigateInFlight` guard mean at most one Investigate run is active per loop — a slow or
throttled run delays the next tick rather than stacking concurrent runs.

Decision: defence in depth. Backoff absorbs transient limits gracefully; the per-run budgets and
circuit breaker guarantee bounded cost and time even if a dependency is hard-down or the model
keeps requesting tools.

### Phase 6: Revised Investigate prompt

`src/prompts/investigatePrompt.ts` — template with `{{STEP_1_JSON}}` token and
`buildInvestigatePrompt(step1Json: string)` (reject empty input; assert token consumed),
mirroring `buildClassifyPrompt`. The template incorporates the review fixes: tool-awareness,
anti-fabrication with traceability, confidence ceiling, id carry-through, empty-input no-op,
and a mitigation-readiness gate. Draft template body:

```
You are the Investigate stage of the Hokusai Monitoring Agent (stage 2 of 5: Classify,
Investigate, Mitigate, Restore, Verify). You investigate potential infrastructure health
issues identified by the Classify stage. You do NOT remediate.

You receive the validated JSON output of Classify, containing: summary, overall_severity,
incidents[], findings[]. Each incident also includes incident_id, signals (alarms/metrics/
logs), suspected_causes, and an investigation_plan (first_actions, questions_to_answer,
suggested_cloudwatch_queries). USE these fields — do not re-derive them. Findings have no id.

Treat Classify output as preliminary. Validate or downgrade each item based on evidence.

## Tools
You have read-only tools to gather evidence:
- query_logs: run a CloudWatch Logs Insights query against a log group.
- get_metrics_and_alarms: read metric statistics and alarm state history.
Use suggested_cloudwatch_queries and signals to target your queries. Prefer a small number of
high-value queries. You have a limited tool budget; stop gathering once you can characterise
an item. If a tool returns an error or no data, treat missing telemetry as a finding — do not
invent results.

## Method
- Start from the highest severity / highest confidence items.
- Correlate across metrics, logs, and alarm history; look for timing relationships
  (errors after a deploy, latency before errors, downstream before upstream).
- Determine whether the affected service is the true source or merely surfacing a downstream
  failure. Avoid overfitting to a single metric.

## Evidence discipline
- Every entry in confirmed_facts and supporting_evidence MUST be traceable to a specific
  Step 1 field or a tool result you actually received. Quote or reference it. If you have no
  evidence beyond Step 1, leave the array empty and record the gap in unknowns.
- Do NOT assign a per-item confidence higher than that item's Step 1 confidence unless you
  obtained corroborating evidence from a tool.
- Do not fabricate logs, metrics, timestamps, or service names. Preserve service names exactly
  as given in Step 1.
- Do not recommend remediation. Any remediation idea goes in possible_future_remediation,
  labelled as a possibility, never an instruction.

## Identifiers
- For each incident, copy incident_id into the investigation's incident_id.
- For each finding (no id in Step 1), synthesise a stable id of the form
  "finding-<index>" using its position in findings[].

## Empty input
If incidents[] and findings[] are both empty, return overall_assessment
NO_ACTIONABLE_INCIDENT, overall_severity NONE, empty investigations[], empty
cross_cutting_observations[], empty priority_order[].

## Output
Return JSON only. No markdown. Schema:

{
  "summary": "",
  "overall_assessment": "ACTIVE_INCIDENT | POSSIBLE_INCIDENT | OBSERVABILITY_ISSUE | NO_ACTIONABLE_INCIDENT | INSUFFICIENT_EVIDENCE",
  "overall_severity": "CRITICAL | HIGH | MEDIUM | LOW | NONE",
  "investigations": [
    {
      "incident_id": "",
      "title": "",
      "original_classification": "",
      "investigation_status": "CONFIRMED_INCIDENT | POSSIBLE_INCIDENT | LIKELY_NON_INCIDENT | OBSERVABILITY_GAP | INSUFFICIENT_EVIDENCE",
      "severity": "CRITICAL | HIGH | MEDIUM | LOW | NONE",
      "confidence": 0.0,
      "affected_services": [],
      "confirmed_facts": [],
      "supporting_evidence": [],
      "contradicting_evidence": [],
      "likely_causes": [ { "cause": "", "confidence": 0.0, "evidence": [] } ],
      "unknowns": [],
      "additional_data_needed": [ { "data": "", "reason": "", "suggested_query_or_source": "" } ],
      "recommended_next_investigation_steps": [ { "priority": 1, "action": "", "expected_signal": "" } ],
      "requires_more_evidence_before_mitigation": true,
      "possible_future_remediation": []
    }
  ],
  "cross_cutting_observations": [],
  "priority_order": [ { "rank": 1, "incident_id": "", "title": "", "reason": "" } ]
}

## Constraints
- Be conservative; do not claim root cause unless evidence supports it.
- Do not ignore LOW findings that indicate observability blind spots.
- Set requires_more_evidence_before_mitigation=false ONLY for CONFIRMED_INCIDENT items whose
  root cause is supported by gathered evidence; otherwise true.
- Emit one investigations[] entry per Step 1 incident and finding.

## Step 1 Input
{{STEP_1_JSON}}
```

Decisions captured vs. the original draft prompt:
- Added `incident_id` (incidents) + synthesised `finding-<n>` ids, and `incident_id` in `priority_order`, so `Mitigate` can map items without title fuzzy-matching.
- Added `requires_more_evidence_before_mitigation` gate for a machine-checkable handoff.
- Tightened anti-fabrication to "traceable to a Step 1 field or a real tool result".
- Added the confidence ceiling rule to prevent inflation.
- Specified the empty-input no-op and explicit use of nested Step 1 fields.

### Phase 7: Investigate stage orchestration

`src/stages/investigate.ts`, mirroring `classify.ts`:

1. `run(input, config, classification: ClassificationResult)`:
   - If `classification.incidents` and `classification.findings` are both empty, OR the
     classification is the Stage 1 failure fallback, short-circuit and return a success
     `StageResult` with a `NO_ACTIONABLE_INCIDENT` `InvestigationResult` (no LLM/tool calls).
   - Serialize the validated `ClassificationResult` (not raw Stage-1 text) and build the prompt.
   - Build `ToolContext` from config; assemble tools via the registry.
   - Call `callOpenRouterWithTools` with the Investigate model.
   - `stripMarkdownFences` (reuse the helper — extract to a shared util or copy) → `JSON.parse`
     → `parseInvestigation`.
   - On parse/validate failure: exactly **one** repair retry that appends "previous response
     was invalid; return valid JSON matching the schema" (tools still available but the model
     should now answer). On second failure: return a safe fallback `InvestigationResult`
     (`INSUFFICIENT_EVIDENCE`, `NONE`, empty arrays, summary describing the failure). Never
     throw out of `run`.
2. Log tool-call count and iteration count for observability.

Decision: identical resilience contract to Stage 1 — the monitoring loop must survive bad LLM
output, and downstream stages must never receive invented data.

### Phase 8: Orchestrator wiring

1. In `src/orchestrator.ts`, after a successful Classify that produced a non-fallback result,
   chain into Investigate within the same async task (`runClassifyAsync` → run Investigate when
   actionable items exist; otherwise log and skip).
2. Add an `investigateInFlight` guard analogous to `classifyInFlight` (the loop must stay
   non-blocking; chained work runs inside the existing unawaited task).
3. Log the `InvestigationResult` summary; keep full JSON behind the existing debug log style.
4. Remove `investigateStage` from `src/stages/stubs.ts`; leave `mitigate`/`restore`/`verify`.

Decision: chaining lives inside the existing non-blocking task so the scheduler contract from
Stage 1 is preserved. Investigate only runs when Classify found something to investigate.

### Phase 9: IAM, credentials, env

1. Investigate needs **live read access** to the AWS account (beyond the single S3 bucket).
   Minimum read-only IAM actions:
   - `logs:StartQuery`, `logs:GetQueryResults`, `logs:StopQuery`, `logs:FilterLogEvents`, `logs:DescribeLogGroups`.
   - `cloudwatch:GetMetricStatistics`, `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics`, `cloudwatch:DescribeAlarms`, `cloudwatch:DescribeAlarmHistory`.
   - (Existing) `s3:GetObject` on the health-report bucket.
   - Explicitly **no** write/mutate actions.
2. Credentials via the standard AWS provider chain (env/instance role) — same as `fetchReport`;
   never passed through tool args.
3. Update `.env.example` and `README.md` with the new vars (Phase 2) and an IAM note.

Decision: document IAM as a required manual step; it is the real gate to shipping this tier.

### Phase 10: Tests and validation

All external calls mocked (no real AWS/OpenRouter), following `src/__tests__/` conventions.

- `investigationSchema.test.ts`: accepts the empty/no-actionable payload; rejects bad
  severity/assessment/status enums; rejects confidence outside `[0,1]`; rejects missing
  required fields; rejects bad `original_classification`.
- `investigatePrompt.test.ts`: substitutes Step-1 JSON; leaves no `{{STEP_1_JSON}}`; rejects
  empty input.
- `tools/registry.test.ts`: unknown tool name → error string (no throw); invalid args → Zod
  error string; result truncation at `maxResultChars`; lookback clamped to max; handler
  exception → error string, loop continues.
- `tools/cloudwatchLogs.test.ts` and `tools/cloudwatchMetrics.test.ts`: mocked SDK returns
  compact text; timeout path; AWS error path; empty-result path.
- `toolLoop.test.ts`: single-turn (no tool_calls) returns content; one tool_call round-trip
  appends `role:'tool'` and loops; `maxIterations` triggers the final forced-answer turn;
  whole-loop timeout → `LlmError`; asserts `response_format` is NOT set when tools present.
- `investigate.test.ts`: empty classification short-circuits with no LLM call; happy path
  returns validated result; fence stripping; one repair retry then success; repair fails →
  safe fallback; failure fallback when Stage 1 was a fallback result.
- `orchestrator.test.ts` (extend): Classify→Investigate chaining on actionable result;
  Investigate skipped when no incidents/findings; `investigateInFlight` guard; errors logged
  and loop continues.
- `types`/`stubs` tests updated for the removed `investigateStage` and widened `StageResult`.

Validation commands:

```bash
pnpm install   # pulls @aws-sdk/client-cloudwatch-logs, @aws-sdk/client-cloudwatch
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Manual verification:

- Set `OPENROUTER_API_KEY`, an `INVESTIGATE_MODEL` that supports tool calling, and AWS
  credentials with the read-only IAM above.
- Run `pnpm start` against a report that yields at least one finding; confirm Investigate runs
  after Classify, makes ≤ `INVESTIGATE_MAX_TOOL_ITERATIONS` tool calls, and logs a
  schema-valid `InvestigationResult`.
- Point a tool at a non-existent log group; confirm the stage records a telemetry gap rather
  than crashing, and the loop continues.

## Risks and Mitigations

- **json-mode + tool_calls incompatibility** on some providers → don't set `response_format`
  during tool turns; enforce JSON via prompt + fence-strip + Zod + one repair retry.
- **Runaway tool loop / cost** → `maxIterations`, per-tool timeout, whole-loop timeout,
  result truncation, lookback clamps.
- **Context blow-up from large log/metric results** → `TOOL_RESULT_MAX_CHARS` truncation with
  marker; prefer Insights aggregations over raw event dumps.
- **Confidence inflation / fabrication** → traceability rule + confidence ceiling in the
  prompt; schema can't enforce semantics, so this is prompt-enforced and spot-checked in eval.
- **Model without tool support** configured for Investigate → document the requirement; the
  loop surfaces a clear `LlmError` if `tools` are unsupported.
- **IAM not provisioned** → tools return error strings; stage degrades to triage (records
  data-needed) instead of failing. Documented as a manual step.
- **Read-only guarantee** → structurally enforced by importing only read-only SDK commands
  under `src/tools/`; covered by code review, not just convention.

## Release Readiness

- `database_change_risk`: `none`
- `new_dependencies`: `@aws-sdk/client-cloudwatch-logs`, `@aws-sdk/client-cloudwatch`
- `env_changes`: `INVESTIGATE_MODEL`, `INVESTIGATE_MODEL_FALLBACK`,
  `INVESTIGATE_MAX_TOOL_ITERATIONS`, `INVESTIGATE_MAX_TOOL_CALLS`, `TOOL_MAX_CONCURRENCY`,
  `TOOL_TIMEOUT_MS`, `TOOL_RESULT_MAX_CHARS`, `TOOL_DEFAULT_LOOKBACK_MINUTES`,
  `TOOL_MAX_LOOKBACK_MINUTES`, `INVESTIGATE_LLM_TIMEOUT_MS`, `OPENROUTER_MAX_RETRIES`,
  `OPENROUTER_BACKOFF_BASE_MS`, `OPENROUTER_BACKOFF_MAX_MS`, `AWS_MAX_ATTEMPTS`,
  `INVESTIGATE_CONSECUTIVE_FAILURE_LIMIT`
- `iam_changes`: read-only CloudWatch Logs + CloudWatch (metrics/alarms) actions listed in Phase 9
- `manual_steps`: `pnpm install`; provision read-only IAM; set a tool-capable `INVESTIGATE_MODEL`

## Resolved Decisions

1. **Logs tool:** CloudWatch Logs Insights (`StartQuery`/poll), for aggregation support. ✅
2. **Investigate model:** primary `openai/gpt-5.4`; backup `anthropic/claude-3.5-sonnet` via
   `INVESTIGATE_MODEL_FALLBACK`, attempted once per run on model-unavailable/tools-unsupported
   errors. ✅
3. **v1 tool set:** CloudWatch Logs Insights + CloudWatch metrics/alarm-history only; ECS/ELB
   deferred. ✅
4. **Severity:** Investigate may raise `overall_severity` above Stage 1 (e.g. NONE→MEDIUM from
   findings, as in the worked example); the prompt allows it. ✅
