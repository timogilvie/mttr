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