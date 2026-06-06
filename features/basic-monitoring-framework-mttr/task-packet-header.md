# Basic Monitoring Framework - MTTR (Classify Stage) - Quick Reference

**Issue ID**: HOK-2082

## Objective

Build the foundation of a five-stage monitoring agent (Classify → Investigate → Mitigate → Restore → Verify) and fully implement only the **Classify** stage. The Classify stage fetches the latest Hokusai CloudWatch Health Report from S3, renders an LLM prompt that embeds the report, calls an LLM via **OpenRouter**, and returns a validated structured incident classification (JSON). The stage runs as a non-blocking step in a loop scaffold so future stages can run incidents independently.

## Key Files

- `features/basic-monitoring-framework-mttr/agent/loop.py` (new) — loop scaffold with five non-blocking stages
- `features/basic-monitoring-framework-mttr/agent/stages/classify.py` (new) — Classify stage logic
- `features/basic-monitoring-framework-mttr/agent/health_report.py` (new) — S3 fetch of the health report
- `features/basic-monitoring-framework-mttr/agent/openrouter_client.py` (new) — OpenRouter client
- `features/basic-monitoring-framework-mttr/agent/prompts/classify.md` (new) — classifier prompt template with `{{HEALTH_REPORT}}` placeholder

## Critical Constraints

1. **Classify only** — scaffold the other four stages as no-op placeholders; do NOT implement Investigate/Mitigate/Restore/Verify logic.
2. **Stages must be non-blocking** — the loop must not block while an incident runs; use async/background execution.
3. **LLM access only via OpenRouter** — model selectable via env/config; output MUST be parsed and schema-validated, never invent facts not in the report.

## Success Criteria (High-Level)

- [ ] Classify fetches the latest report from `s3://hokusai-health-reports-development/latest/development/report.md` with explicit error handling
- [ ] OpenRouter call returns JSON matching the required classification schema (validated, with retry on malformed output)
- [ ] Given the sample healthy report, Classify returns `overall_severity: NONE` with empty `incidents`
- [ ] Loop scaffold runs Classify non-blocking with the other four stages stubbed
- [ ] Tests and lint pass; PR created and linked to HOK-2082

## Detailed Sections

Full details available on-demand in task-packet-details.md:

- [Section 1: Complete Objective & Scope](#1-objective)
- [Section 2: Technical Context](#2-technical-context)
- [Section 3: Implementation Approach](#3-implementation-approach)
- [Section 4: Success Criteria](#4-success-criteria)
- [Section 5: Implementation Constraints](#5-implementation-constraints)
- [Section 6: Validation Steps](#6-validation-steps)
- [Section 8: Definition of Done](#8-definition-of-done)
- [Section 9: Rollback Plan](#9-rollback-plan)
- [Section 10: Release Readiness](#10-release-readiness)
- [Section 11: Proposed Labels](#11-proposed-labels)

**Implementation Note**: Start with this overview. Read detailed sections on-demand as you implement.