# T6 · Orchestrator out-of-band investigation entry point - Quick Reference

**Issue ID**: HOK-2440

## Objective

Implement the T6 alarm-launched investigation entry point in `src/orchestrator.ts` so a claimed trigger batch can bypass Classify, synthesize a `ClassificationResult`, and run the existing `Investigate -> Decide -> Verify` flow. The alarm-born path must persist `trigger_source='alarm'`, attach the originating `alarm_triggers` rows to the launched run, and dedupe cleanly with the scheduled report-driven path.

## Key Files

- `src/orchestrator.ts` - replace the T6 placeholder and reuse the scheduled downstream flow
- `src/state/repository.ts` - run provenance and any repository seam needed by the alarm path
- `src/report/mandatoryIncidents.ts` - mandatory-spec dedupe behavior must align across alarm and report entry points
- `src/state/agentState.ts` - observation reconciliation and canonical observation keys are part of the merge path
- `src/web/api.ts` - read-side incident dedupe may need adjustment if alarm/report rows diverge
- `src/__tests__/orchestrator.test.ts` - new T6 orchestration coverage
- `src/__tests__/stateRepository.test.ts` - run provenance persistence coverage
- `src/__tests__/webApi.test.ts` - read-side dedupe coverage if API dedupe logic changes

## Critical Constraints

1. Reuse the existing `investigateInFlight` single-flight guard. An alarm launch must return `busy` rather than racing the scheduled path.
2. Do not add a second investigation pipeline. The new entry point must drive the existing `runInvestigate -> runDecide -> runSelectedResponseStage` chain.
3. Dedupe must hold at all three layers called out in the design doc: observation reconciliation, mandatory-spec coverage, and read-side incident collapsing.
4. Persist alarm provenance on the run and on the originating `alarm_triggers` rows without introducing duplicate incidents for the same window.

## Success Criteria (High-Level)

- [ ] `runInvestigationFromTrigger(batch)` launches the existing downstream stages from synthesized alarm specs
- [ ] the launched run is recorded with `trigger_source='alarm'`
- [ ] the claimed `alarm_triggers` rows link back to the launched run
- [ ] a matching report-born incident in the same window dedupes to one incident
- [ ] tests cover launch, busy handling, provenance, and dedupe

## Detailed Sections

Full details available on-demand in `task-packet-details.md`:

- [Section 1: Objective and Scope](#1-objective-and-scope)
- [Section 2: Technical Context](#2-technical-context)
- [Section 3: Implementation Approach](#3-implementation-approach)
- [Section 4: Validation](#4-validation)
- [Section 5: Release Readiness](#5-release-readiness)

**Implementation Note**: Start with `src/orchestrator.ts`, `src/state/repository.ts`, `src/report/mandatoryIncidents.ts`, and `src/web/api.ts`. The design anchor is `docs/alarm-triggered-investigation.md` section 5.4, and the consumer contract is already defined in `src/alarm/triggerConsumer.ts`.
