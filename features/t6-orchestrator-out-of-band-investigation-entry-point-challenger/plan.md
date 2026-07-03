# Implementation Plan — T6 · Orchestrator out-of-band investigation entry point (HOK-2440)

## 1. Objective

Implement `runInvestigationFromTrigger(batch)` in `src/orchestrator.ts` so a coalesced alarm-trigger batch can bypass Classify, synthesize a `ClassificationResult`, and execute the existing `Investigate -> Decide -> Verify` flow while persisting `trigger_source='alarm'` and deduping with the scheduled report path.

## 2. Research Findings

- `src/orchestrator.ts` already contains the exact downstream chain needed for T6:
  - `canonicalizeClassificationIncidents`
  - scheduled-path reconciliation and persistence in `runClassifyAsync`
  - `runInvestigate`, `runDecide`, `runSelectedResponseStage`
  - the `investigateInFlight` single-flight guard
- `src/alarm/triggerConsumer.ts` already handles queueing, coalescing, cooldown, and trigger-row completion. On a successful launch it writes `alarm_triggers.run_id`, so T6 only needs to return a real `runId`.
- `src/state/repository.ts` already has schema support for `runs.trigger_source` and `alarm_triggers.run_id`, but `startRun` does not yet accept a trigger source argument.
- The three dedupe layers already exist but must stay aligned for alarm-born incidents:
  - write-time observation identity via `canonicalObservationKey` / `reconcileObservations`
  - mandatory-spec coverage via `specDedupeKey` / `incidentCoversSpec`
  - read-side collapse via `dedupeIncidents` in `src/web/api.ts`
- Existing migration `alarm_triggers_queue` already covers the persistence fields this ticket needs, so no new migration is expected unless implementation uncovers a gap.

## 3. Implementation Phases

### Phase 1: Shared alarm/scheduled classification handling

1. Extract or factor the scheduled-path classification persistence work in `src/orchestrator.ts` into a shared helper that can be called from both:
   - `runClassifyAsync` after LLM classification
   - `runInvestigationFromTrigger` after alarm-spec synthesis
2. Keep that helper responsible for:
   - canonicalizing incident ids
   - reconciling observations against state
   - saving state
   - recording classification stage output and incident events
   - determining whether downstream investigation should run

Reasoning:
The scheduled path already implements the correct persistence behavior. Reusing that logic is lower risk than duplicating it and hoping the three dedupe layers stay identical.

### Phase 2: Alarm entry point and run provenance

1. Implement `runInvestigationFromTrigger(batch)` in `src/orchestrator.ts`.
2. Preserve the same single-flight semantics as the scheduled tick:
   - if `investigateInFlight` is already true, return `{ status: 'busy' }`
   - otherwise build the synthesized classification payload and start the run
3. Extend repository run creation so the orchestrator can call `startRun(timestamp, 'alarm')` while scheduled runs continue to default to `'scheduled'`.
4. Ensure downstream failures still finish the run as `error` and surface `status: 'error'` back to the consumer.

Reasoning:
This is the smallest change that satisfies the queue consumer contract while preserving the existing scheduler and repository behavior.

### Phase 3: Dedupe verification and read-side cleanup

1. Confirm the synthesized incidents produce the same canonical identity as report-born mandatory incidents for the same alarm signal and service.
2. Verify `specDedupeKey` / `incidentCoversSpec` still merge alarm-born and report-born variants instead of producing a second incident.
3. Check whether `src/web/api.ts` needs a read-side dedupe adjustment. Only change it if alarm/report duplicates can still appear in status or incident-list responses after the write path is fixed.

Reasoning:
The ticket explicitly calls out all three layers. The plan should assume the write path may be sufficient, but the coding phase needs to prove that rather than ignore the API layer.

## 4. File Targets

- `src/orchestrator.ts`
  - implement the T6 entry point
  - factor shared classification persistence logic if needed
- `src/state/repository.ts`
  - add trigger-source support to `startRun`
  - keep scheduled default behavior intact
- `src/web/api.ts`
  - only if required by dedupe verification
- `src/__tests__/orchestrator.test.ts`
  - replace the T6 placeholder expectation with real launch-path tests
- `src/__tests__/stateRepository.test.ts`
  - cover `trigger_source='alarm'` and scheduled default behavior
- `src/__tests__/webApi.test.ts`
  - only if read-side dedupe behavior changes

## 5. Edge Cases and Gotchas

- `investigateInFlight` currently flips inside `runInvestigate`, not at the start of `runInvestigationFromTrigger`. The implementation has to avoid a race where the alarm path starts work while another investigation is entering the downstream stage.
- `runClassifyAsync` also records report fingerprints and skip behavior; that logic should not leak into the alarm path.
- The alarm path should not invent a second shape for incidents. It needs to synthesize incidents/findings that already satisfy `ClassificationResult` and existing canonical-key logic.
- `src/web/api.ts` dedupes by title, service, and severity preference, not by canonical observation key. If alarm-born titles or severity diverge from the report path, the API may still show duplicates even when storage merged correctly.

## 6. Planned Test Coverage

1. `src/__tests__/orchestrator.test.ts`
   - successful `runInvestigationFromTrigger` returns `launched` with a run id
   - the synthesized classification reaches Investigate/Decide/Verify
   - an already in-flight investigation returns `busy`
   - matching alarm/report incidents reconcile to one incident identity
2. `src/__tests__/stateRepository.test.ts`
   - `startRun(timestamp, 'alarm')` persists `trigger_source='alarm'`
   - `startRun(timestamp)` still persists the scheduled default
3. `src/__tests__/webApi.test.ts`
   - only if required: alarm/report duplicate rows still collapse to one response incident

## 7. Release Readiness

- `database_change_risk`: `none`
- `env_changes`: `none`
- `config_changes`: `none`
- `manual_steps`: `none`

## 8. Planning Provenance

- Local task packet artifacts were created in the feature directory because the automated expander did not produce files in this environment.
- Post-expansion routing was saved to `features/t6-orchestrator-out-of-band-investigation-entry-point-challenger/.post-expansion-route.json`.
- No migration marker was created. Current repo research indicates the required persistence fields already exist in migration `alarm_triggers_queue`.
