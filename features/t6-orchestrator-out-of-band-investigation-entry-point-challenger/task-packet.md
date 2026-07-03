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

---

## 1. Objective and Scope

### What

Add a real implementation for `Orchestrator.runInvestigationFromTrigger(batch)` that accepts a coalesced alarm batch, converts its synthesized specs into a `ClassificationResult`, records an alarm-sourced run, reconciles the resulting observations against existing state, and executes the existing downstream stages.

### Why

T5 delivered queueing, coalescing, severity gating, cooldown attachment, and a seam for the launcher, but the launcher still returns a placeholder error. T6 is the feature ticket that turns queued alarm triggers into actual investigations while keeping incidents unified across alarm-driven and scheduled report-driven paths.

### Scope In

- Build a `ClassificationResult`-shaped payload directly from the synthesized alarm specs.
- Canonicalize and reconcile the synthesized incidents through the same state path used by scheduled runs.
- Record a run with alarm provenance.
- Ensure claimed trigger rows are attached to the launched run through the existing queue tables.
- Preserve incident unification across alarm and report entry points.
- Add focused unit tests around the new entry point and any repository or read-side dedupe changes it requires.

### Scope Out

- No changes to the SNS ingress route or trigger consumer algorithm.
- No new stage types and no redesign of Investigate/Decide/Verify prompts.
- No new database tables unless implementation research proves an unavoidable schema gap.
- No OK/recovery handling from design section 5.5; this ticket is the ALARM launch path only.

## 2. Technical Context

### Existing implementation seams

- `src/orchestrator.ts` already has:
  - `canonicalizeClassificationIncidents`
  - `runInvestigate`, `runDecide`, `runSelectedResponseStage`
  - the `investigateInFlight` guard
  - a T6 placeholder `runInvestigationFromTrigger`
- `src/alarm/triggerConsumer.ts` already:
  - coalesces by `spec_key`
  - respects `launcher.isBusy()`
  - claims rows and marks them `done` with `run_id` on successful launch
- `src/state/repository.ts` already:
  - stores `alarm_triggers.run_id`
  - exposes `TriggerSource = 'scheduled' | 'alarm'`
  - adds `runs.trigger_source` in migration `alarm_triggers_queue`
  - still starts runs without a trigger-source argument
- `src/web/api.ts` already performs read-side dedupe for legacy duplicate incident rows by title/service/severity preference

### Dedupe paths that matter

1. `src/state/agentState.ts`
   - `reconcileObservations` keys incidents by `canonicalObservationKey('incident', incident)`
2. `src/report/mandatoryIncidents.ts`
   - report-born mandatory incidents are deduped by `specDedupeKey`
   - `incidentCoversSpec` determines whether a spec should attach to an existing incident instead of creating a new one
3. `src/web/api.ts`
   - `dedupeIncidents` collapses legacy duplicate rows in status and incident-list responses

### Likely touch points

- `src/orchestrator.ts`
  - implement the T6 entry point
  - factor shared scheduled/alarm reconciliation logic if needed to avoid drift
- `src/state/repository.ts`
  - extend `startRun` so the orchestrator can persist `trigger_source='alarm'`
  - update repository tests for the new argument and stored value
- `src/web/api.ts`
  - confirm read-side dedupe still collapses alarm/report duplicates; tighten only if the new write path exposes a mismatch

### Migration expectation

Current migration coverage already includes `alarm_triggers.run_id` and `runs.trigger_source`. The default assumption for T6 is no new schema migration; only raise one if implementation discovers a real persistence gap.

## 3. Implementation Approach

1. Replace the placeholder in `runInvestigationFromTrigger(batch)` with the real control flow:
   - return `{ status: 'busy' }` immediately if `investigateInFlight` is already set
   - synthesize a classification payload from the batch specs
   - start a run with `trigger_source='alarm'`
   - reconcile and persist classification output the same way the scheduled path does
   - run the existing downstream stage chain
   - return `{ status: 'launched', runId }` or `{ status: 'error', message }`
2. Avoid duplicating scheduled logic by extracting a small shared helper for:
   - canonicalizing incidents
   - reconciling observations
   - recording classification stage output and incident events
   - deciding whether downstream investigation should run
3. Extend repository run creation so the orchestrator can explicitly mark alarm-sourced runs while preserving the scheduled default.
4. Verify the synthesized incidents match the report path's dedupe signals:
   - canonical observation key inputs must line up
   - `specDedupeKey` / `incidentCoversSpec` must treat alarm-born and report-born variants as the same incident
   - read-side incident collapsing must still converge on one incident row when historical duplicates exist
5. Add or update unit tests for:
   - successful alarm launch through downstream stages
   - busy short-circuit when `investigateInFlight` is already set
   - run provenance persistence
   - dedupe with a matching report-born incident

## 4. Validation

### Required test coverage

- `src/__tests__/orchestrator.test.ts`
  - alarm launch returns `launched` and invokes Investigate/Decide/Verify
  - alarm launch returns `busy` when Investigate is already in flight
  - synthesized incidents are canonicalized and reconciled before downstream stages
- `src/__tests__/stateRepository.test.ts`
  - `startRun(..., 'alarm')` persists `trigger_source='alarm'`
  - default scheduled runs remain `trigger_source='scheduled'`
- `src/__tests__/webApi.test.ts`
  - only if needed: alarm/report duplicate rows still collapse to one API incident

### Behavioral checks

- A claimed alarm trigger batch produces a run and links back to the trigger rows via `alarm_triggers.run_id`.
- The resulting incident identity matches the report path so the same event window does not create a second incident.
- Failure in downstream stages marks the run as error and returns `status: 'error'` to the consumer.

## 5. Release Readiness

- `database_change_risk`: `none` unless an implementation gap is discovered
- `env_changes`: `none`
- `config_changes`: `none`
- `manual_steps`: `none`
