# T2 · Config & env plumbing for the alarm webhook - Quick Reference

**Issue ID**: HOK-2435

## Objective

Add a validated configuration surface for the alarm-triggered investigate loop by introducing eight `ALARM_*` environment variables into `src/config.ts` and documenting them across `.env.example`, `.env.compose.example`, and `.env.ec2.example`. The feature must ship dark: `ALARM_WEBHOOK_ENABLED` defaults to `false` so no ingress route or consumer activates. This is pure config plumbing — no webhook route, SNS handler, or consumer logic is built here (those are downstream tickets under epic HOK-2433).

## Key Files

- `src/config.ts` — add `ALARM_*` parsing/validation and export typed config
- `src/__tests__/config.test.ts` — add tests for defaults, parsing, and validation
- `.env.example` — document all eight vars with defaults/comments
- `.env.compose.example` — mirror the documented vars
- `.env.ec2.example` — mirror the documented vars

## Critical Constraints

1. **Ships dark**: `ALARM_WEBHOOK_ENABLED` MUST default to `false`; config must parse cleanly with zero `ALARM_*` vars set.
2. **Follow the existing `src/config.ts` pattern** — match the current parsing/validation idiom (env reads, boolean/number coercion, error handling) exactly; do not introduce a new config library.
3. **No behavioral wiring** — do not add routes, consumers, SNS handlers, or reference `ALARM_WEBHOOK_PATH_TOKEN` outside config. Config surface only.

## Success Criteria (High-Level)

- [ ] All eight `ALARM_*` vars parse into a typed config object with the specified defaults
- [ ] Config validates cleanly when no `ALARM_*` vars are set (disabled by default)
- [ ] Invalid numeric/boolean/enum values produce clear, specific errors (or documented fallback)
- [ ] All eight vars documented in `.env.example`, `.env.compose.example`, `.env.ec2.example`
- [ ] Tests and lint pass; PR created and linked to HOK-2435

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

**Implementation Note**: Start with this overview. Read detailed sections on-demand as you implement. First action: open `src/config.ts` and `src/__tests__/config.test.ts` to learn the existing parsing/validation idiom before writing anything.