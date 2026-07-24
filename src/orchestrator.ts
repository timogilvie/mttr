import type { Config } from './config.js';
import type {
  StageInput,
  ClassificationResult,
  InvestigationResult,
  DecisionResult,
  MitigationResult,
  VerificationResult,
} from './types.js';
import * as classifyStage from './stages/classify.js';
import * as investigateStage from './stages/investigate.js';
import * as decideStage from './stages/decide.js';
import * as verifyStage from './stages/verify.js';
import * as mitigateStage from './stages/mitigate.js';
import { sendMitigationProposalAlerts, sendSlackAlerts } from './alerts/slack.js';
import { fetchReport } from './report/fetchReport.js';
import { alarmSpecFromSns } from './report/alarmSpecFromSns.js';
import {
  buildClassificationFromSpecs,
  type MandatoryIncidentSpec,
} from './report/mandatoryIncidents.js';
import {
  canonicalObservationKey,
  hashReportContent,
  hasProcessedReport,
  reconcileObservations,
  recordProcessedReport,
  type AgentState,
  type ObservationReconciliation,
} from './state/agentState.js';
import { collapseExactCloudWatchDuplicates } from './state/correlation.js';
import {
  createAgentStateRepository,
  type AlarmTriggerRow,
  type IncidentEventInput,
  type AgentStateRepository,
  type RecoveryIncidentCandidate,
  type StaleIncidentRow,
} from './state/repository.js';
import type { IncidentTransition } from './state/transitions.js';
import {
  startAlarmTriggerConsumer,
  type AlarmTriggerBatch,
  type AlarmTriggerConsumerHandle,
  type TriggerInvestigationLauncher,
  type TriggerLaunchResult,
  type RecoveryVerifyResult,
} from './alarm/triggerConsumer.js';

function remapIncidentReference(value: string | null | undefined, idMap: Map<string, string>): string | null | undefined {
  if (!value) {
    return value;
  }
  return idMap.get(value) ?? value;
}

function canonicalizeClassificationIncidents(classification: ClassificationResult): ClassificationResult {
  const idMap = new Map(
    classification.incidents.map((incident) => [
      incident.incident_id,
      canonicalObservationKey('incident', incident),
    ])
  );

  return {
    ...classification,
    incidents: classification.incidents.map((incident) => {
      const canonicalId = idMap.get(incident.incident_id) ?? incident.incident_id;
      const semantics = incident.semantics
        ? {
            ...incident.semantics,
            duplicate_of: remapIncidentReference(incident.semantics.duplicate_of, idMap),
            root_incident_id: remapIncidentReference(incident.semantics.root_incident_id, idMap),
            upstream_incident_ids: incident.semantics.upstream_incident_ids.map(
              (id) => idMap.get(id) ?? id
            ),
            downstream_incident_ids: incident.semantics.downstream_incident_ids.map(
              (id) => idMap.get(id) ?? id
            ),
          }
        : undefined;
      return {
        ...incident,
        incident_id: canonicalId,
        ...(semantics ? { semantics } : {}),
      };
    }),
  };
}

export class Orchestrator {
  private intervalId: NodeJS.Timeout | null = null;
  private classifyInFlight = false;
  private investigateInFlight = false;
  private recoveryVerifyInFlight = false;
  private readonly config: Config;
  private readonly stateRepository: AgentStateRepository;
  private triggerConsumerHandle: AlarmTriggerConsumerHandle | null = null;

  constructor(config: Config) {
    this.config = structuredClone(config);
    this.stateRepository = createAgentStateRepository(this.config);
  }

  /** Public read of the single-flight investigate guard — the T5 consumer's concurrency seam. */
  get investigateBusy(): boolean {
    return this.investigateInFlight;
  }

  /**
   * T6 out-of-band entry point (design §5.4): builds a ClassificationResult-shaped payload from
   * the coalesced alarm-trigger batch — bypassing the LLM Classify stage entirely — and drives
   * the existing runInvestigate → runDecide → runSelectedResponseStage chain, recording
   * `trigger_source = 'alarm'`. The consumer links the originating `alarm_triggers` rows back to
   * the returned `runId` itself (via `completeAlarmTriggers`) once this resolves `launched`.
   */
  async runInvestigationFromTrigger(batch: AlarmTriggerBatch): Promise<TriggerLaunchResult> {
    // Cross-path mutex: reject when EITHER the scheduled Classify tick or another Investigate
    // stage is in flight. Both entry points share persistClassification, which does
    // load()->reconcileObservations()->save() against the same AgentState; a concurrent scheduled
    // Classify would race the alarm path here (last-writer-wins on PostgresAgentStateRepository's
    // DELETE+INSERT of observation_states, silently dropping one run's changes). The fast-path
    // check-and-flip is synchronous — no await between the checks and the flip — so any tick that
    // arrives after this returns will see `investigateInFlight = true` and its `tick()` fast-path
    // will skip.
    if (this.classifyInFlight || this.investigateInFlight) {
      console.log(
        '[Orchestrator] Classify or Investigate stage already in flight, deferring alarm trigger batch'
      );
      return { status: 'busy' };
    }
    this.investigateInFlight = true;

    const specs = this.buildAlarmSpecs(batch.triggers);
    if (specs.length === 0) {
      this.investigateInFlight = false;
      return {
        status: 'error',
        message: 'No alarm trigger in the batch produced a valid incident spec',
      };
    }

    const classification = buildClassificationFromSpecs(specs);
    const now = new Date().toISOString();
    let runId: string | undefined;
    let finished = false;

    const finishRun = async (update: {
      status: 'success' | 'error';
      summary?: string;
      overallSeverity?: ClassificationResult['overall_severity'];
      errorMessage?: string;
    }): Promise<void> => {
      if (finished) {
        return;
      }
      finished = true;
      await this.stateRepository.finishRun?.(runId, {
        status: update.status,
        finishedAt: new Date().toISOString(),
        ...(update.summary ? { summary: update.summary } : {}),
        ...(update.overallSeverity ? { overallSeverity: update.overallSeverity } : {}),
        ...(update.errorMessage ? { errorMessage: update.errorMessage } : {}),
      });
    };

    try {
      console.log(
        `[Orchestrator] Starting alarm-triggered investigation for ${specs.length} synthesized spec(s)`
      );
      // Mirrors the scheduled path's tolerance (see runClassifyAsync): backends that don't record
      // runs (e.g. FileAgentStateRepository) leave `runId` undefined and every downstream
      // recordX(runId, ...) call short-circuits on that internally. `run_id` is only actually
      // persisted by the Postgres backend, and that's the backend we require in production for
      // the alarm path (webhook-enabled deploys use Postgres per config).
      runId = await this.stateRepository.startRun?.(now, 'alarm');

      const state = await this.stateRepository.load();
      const {
        classification: canonical,
        reconciliation,
        actionable,
      } = await this.persistClassification(runId, state, classification, now, { partial: true });

      if (!actionable || !reconciliation.shouldInvestigate) {
        console.log(
          '[Orchestrator] Alarm-triggered batch produced no new/changed observations; finishing run'
        );
        await finishRun({
          status: 'success',
          summary: canonical.summary,
          overallSeverity: canonical.overall_severity,
        });
        return { status: 'launched', runId };
      }

      const downstreamSucceeded = await this.runInvestigate(canonical, runId, {
        guardAlreadyHeld: true,
      });
      if (!downstreamSucceeded) {
        const message = 'Investigate or Decide stage failed for alarm-triggered run';
        await finishRun({
          status: 'error',
          summary: canonical.summary,
          overallSeverity: canonical.overall_severity,
          errorMessage: message,
        });
        return { status: 'error', message };
      }

      await finishRun({
        status: 'success',
        summary: canonical.summary,
        overallSeverity: canonical.overall_severity,
      });
      return { status: 'launched', runId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Orchestrator] Unhandled error in alarm-triggered investigation:', error);
      await finishRun({ status: 'error', errorMessage: message });
      return { status: 'error', message };
    } finally {
      this.investigateInFlight = false;
    }
  }

  async runRecoveryVerifyFromTrigger(
    trigger: AlarmTriggerRow,
    incident: RecoveryIncidentCandidate
  ): Promise<RecoveryVerifyResult> {
    if (this.classifyInFlight || this.investigateInFlight || this.recoveryVerifyInFlight) {
      console.log('[Orchestrator] Another stage is in flight, deferring recovery verify');
      return { status: 'busy' };
    }
    this.recoveryVerifyInFlight = true;

    const now = new Date().toISOString();
    let runId: string | undefined;
    let finished = false;

    const finishRun = async (update: {
      status: 'success' | 'error';
      summary?: string;
      errorMessage?: string;
    }): Promise<void> => {
      if (finished) {
        return;
      }
      finished = true;
      await this.stateRepository.finishRun?.(runId, {
        status: update.status,
        finishedAt: new Date().toISOString(),
        ...(update.summary ? { summary: update.summary } : {}),
        ...(update.errorMessage ? { errorMessage: update.errorMessage } : {}),
      });
    };

    try {
      console.log(
        `[Orchestrator] Starting recovery verify for trigger ${trigger.id}, incident ${incident.incidentId}`
      );
      runId = await this.stateRepository.startRun?.(now, 'alarm');

      const decision = this.recoveryDecision(trigger, incident);
      if (decision.decisions.length === 0) {
        const verification = this.emptyRecoveryVerification(trigger, incident);
        await this.stateRepository.recordStageOutput?.(runId, {
          stage: 'Verify',
          data: verification,
        });
        await this.stateRepository.recordIncidentEvents?.(
          runId,
          this.verificationEvents(verification)
        );
        await finishRun({ status: 'success', summary: verification.summary });
        return {
          status: 'not_confirmed',
          runId,
          message: 'Recovery verify had no scoped checks to run',
        };
      }

      const result = await verifyStage.run(
        { stage: 'Verify', timestamp: now },
        this.config,
        decision
      );
      if (result.status !== 'success' || !result.data) {
        const message = result.error ?? 'Verify stage failed';
        await finishRun({ status: 'error', errorMessage: message });
        return { status: 'error', message };
      }

      const verification = this.normalizeRecoveryVerification(
        result.data as VerificationResult,
        trigger
      );
      await this.stateRepository.recordStageOutput?.(runId, {
        stage: 'Verify',
        data: verification,
      });
      await this.stateRepository.recordIncidentEvents?.(
        runId,
        this.verificationEvents(verification)
      );
      const transitions = await this.stateRepository.recordVerificationTransitions?.(
        runId,
        verification
      );
      await this.sendTransitionAlerts(runId, transitions ?? []);
      await finishRun({ status: 'success', summary: verification.summary });

      return verification.overall_status === 'VERIFIED_RECOVERED_TRANSIENT'
        ? { status: 'confirmed', runId }
        : {
            status: 'not_confirmed',
            runId,
            message: `Verify returned ${verification.overall_status}`,
          };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Orchestrator] Unhandled error in recovery verify:', error);
      await finishRun({ status: 'error', errorMessage: message });
      return { status: 'error', message };
    } finally {
      this.recoveryVerifyInFlight = false;
    }
  }

  private recoveryDecision(
    trigger: AlarmTriggerRow,
    incident: RecoveryIncidentCandidate
  ): DecisionResult {
    const alarmName = trigger.alarm_name.trim();
    if (!alarmName) {
      return {
        summary: 'Recovery verify skipped: no alarm name was available.',
        overall_next_stage: 'None',
        decisions: [],
        handoff_notes: [],
      };
    }

    return {
      summary: `Scoped recovery verify for ${incident.title}.`,
      overall_next_stage: 'Verify',
      handoff_notes: [
        `Verify only the recovering alarm/check context for trigger ${trigger.id}.`,
      ],
      decisions: [
        {
          incident_id: incident.incidentId,
          title: incident.title,
          disposition: 'VERIFY',
          next_stage: 'Verify',
          severity: incident.severity,
          affected_services: incident.service ? [incident.service] : [],
          rationale:
            'CloudWatch reported OK for an open alarm-born incident; confirm the scoped health signal before resolving.',
          evidence_to_pass: [
            `alarm=${alarmName}`,
            `state=OK`,
            ...(trigger.spec_key ? [`spec_key=${trigger.spec_key}`] : []),
          ],
          follow_up_actions: [
            `Check current CloudWatch alarm state for alarm=${alarmName}.`,
          ],
        },
      ],
    };
  }

  private emptyRecoveryVerification(
    trigger: AlarmTriggerRow,
    incident: RecoveryIncidentCandidate
  ): VerificationResult {
    return {
      summary: 'Recovery verify could not run scoped checks; leaving incident open.',
      overall_status: 'STILL_INCONCLUSIVE',
      overall_next_stage: 'Investigate',
      verifications: [
        {
          incident_id: incident.incidentId,
          title: incident.title,
          status: 'STILL_INCONCLUSIVE',
          severity: incident.severity,
          rationale: `No scoped recovery check was available for trigger ${trigger.id}.`,
          checks: [],
          recommended_next_stage: 'Investigate',
        },
      ],
    };
  }

  private normalizeRecoveryVerification(
    verification: VerificationResult,
    trigger: AlarmTriggerRow
  ): VerificationResult {
    const normalized = verification.verifications.map((item) => {
      if (
        item.status === 'VERIFIED_NON_INCIDENT' ||
        item.status === 'VERIFIED_OBSERVABILITY_ISSUE' ||
        item.checks.length === 0
      ) {
        return {
          ...item,
          status: 'STILL_INCONCLUSIVE' as const,
          recommended_next_stage: 'Investigate' as const,
          rationale:
            `${item.rationale} Recovery OK from ${trigger.alarm_name} did not prove this alarm-born incident should close.`,
        };
      }
      return item;
    });
    const hasActive = normalized.some((item) => item.status === 'VERIFIED_ACTIVE_INCIDENT');
    const hasInconclusive = normalized.some((item) => item.status === 'STILL_INCONCLUSIVE');
    const allRecovered =
      normalized.length > 0 &&
      normalized.every((item) => item.status === 'VERIFIED_RECOVERED_TRANSIENT');
    const overallStatus = hasActive
      ? 'VERIFIED_ACTIVE_INCIDENT'
      : hasInconclusive
        ? 'STILL_INCONCLUSIVE'
        : allRecovered
          ? 'VERIFIED_RECOVERED_TRANSIENT'
          : 'STILL_INCONCLUSIVE';
    return {
      ...verification,
      summary: `Recovery Verify completed with ${overallStatus}.`,
      overall_status: overallStatus,
      overall_next_stage:
        overallStatus === 'VERIFIED_RECOVERED_TRANSIENT'
          ? 'None'
          : overallStatus === 'VERIFIED_ACTIVE_INCIDENT'
            ? 'Mitigate'
            : 'Investigate',
      verifications: normalized,
    };
  }

  /**
   * Converts each eligible alarm-trigger row's raw SNS payload into a `MandatoryIncidentSpec`,
   * reusing `alarmSpecFromSns` — the same spec builder the report path uses for active-alarm rows
   * — so alarm-born and report-born incidents for the same signal always share the same
   * title/classification/affected_services. Rows whose payload can't be converted (e.g. a shape
   * `alarmSpecFromSns` rejects) are skipped rather than failing the whole batch.
   */
  private buildAlarmSpecs(triggers: AlarmTriggerRow[]): MandatoryIncidentSpec[] {
    const specs: MandatoryIncidentSpec[] = [];
    for (const trigger of triggers) {
      const result = alarmSpecFromSns(trigger.payload);
      if (result.ok) {
        specs.push(result.spec);
      } else {
        console.warn(
          `[Orchestrator] Alarm trigger ${trigger.id} (${trigger.alarm_name}) could not be ` +
            `converted to an incident spec: ${result.reason}`
        );
      }
    }
    return specs;
  }

  /**
   * Shared classification-persistence path (design §5.4 Phase 1): canonicalizes incident ids,
   * reconciles observations against state, saves state, and records the Classify-stage output and
   * incident events. Used by both the scheduled report path (`runClassifyAsync`) and the alarm
   * out-of-band path (`runInvestigationFromTrigger`) so the three dedupe layers stay aligned
   * between them. Report-fingerprint bookkeeping (`recordProcessedReport`) is deliberately kept
   * out of this helper — that's report-path-only state that must not leak into alarm-triggered
   * runs.
   */
  private async persistClassification(
    runId: string | undefined,
    state: AgentState,
    classificationInput: ClassificationResult,
    now: string,
    options: { partial?: boolean } = {}
  ): Promise<{
    classification: ClassificationResult;
    reconciliation: ObservationReconciliation;
    actionable: boolean;
  }> {
    const classification = canonicalizeClassificationIncidents(
      collapseExactCloudWatchDuplicates(classificationInput)
    );
    // Only the complete-report path may pass `partial: false` (default). Partial classifications
    // (e.g. the alarm-triggered batch, which only synthesizes incidents for the alarms in flight)
    // must NOT auto-resolve unrelated active observations that happen to be absent from this
    // batch — see `reconcileObservations`.
    const reconciliation = reconcileObservations(state, classification, now, {
      partial: options.partial ?? false,
    });
    await this.stateRepository.save(state);
    await this.stateRepository.recordReconciliation?.(runId, reconciliation);
    await this.stateRepository.recordStageOutput?.(runId, {
      stage: 'Classify',
      data: classification,
    });
    await this.stateRepository.recordIncidentEvents?.(
      runId,
      this.classificationEvents(classification, reconciliation)
    );
    this.logObservationReconciliation(reconciliation);

    const actionable = classification.incidents.length > 0 || classification.findings.length > 0;
    return { classification, reconciliation, actionable };
  }

  private classificationEvents(
    classification: ClassificationResult,
    reconciliation: ObservationReconciliation
  ): IncidentEventInput[] {
    const findingKeyByTitle = new Map(
      [
        ...reconciliation.newObservations,
        ...reconciliation.changedObservations,
        ...reconciliation.recurringObservations,
      ]
        .filter((observation) => observation.type === 'finding')
        .map((observation) => [observation.title, observation.key])
    );

    const incidentEvents = classification.incidents.map((incident) => ({
      incidentId: incident.incident_id,
      title: incident.title,
      stage: 'Classify' as const,
      message: `${incident.classification}: ${incident.title}`,
      severity: incident.severity,
      service: incident.affected_services[0] ?? null,
      evidence: {
        classification: incident.classification,
        confidence: incident.confidence,
        affected_services: incident.affected_services,
        evidence: incident.evidence,
        signals: incident.signals,
        suspected_causes: incident.suspected_causes,
        semantics: incident.semantics,
      },
    }));

    const findingEvents = classification.findings.map((finding, index) => ({
      incidentId: findingKeyByTitle.get(finding.title) ?? `finding-${index}`,
      title: finding.title,
      stage: 'Classify' as const,
      message: `${finding.classification}: ${finding.title}`,
      severity: finding.severity,
      service: finding.affected_services[0] ?? null,
      evidence: {
        classification: finding.classification,
        confidence: finding.confidence,
        affected_services: finding.affected_services,
        evidence: finding.evidence,
        reason_not_incident: finding.reason_not_incident,
        semantics: finding.semantics,
      },
    }));

    return [...incidentEvents, ...findingEvents];
  }

  private investigationEvents(investigation: InvestigationResult): IncidentEventInput[] {
    return investigation.investigations.map((item) => ({
      incidentId: item.incident_id,
      title: item.title,
      stage: 'Investigate' as const,
      message: `${item.investigation_status}: ${item.title}`,
      severity: item.severity,
      service: item.affected_services[0] ?? null,
      evidence: {
        investigation_status: item.investigation_status,
        confidence: item.confidence,
        confirmed_facts: item.confirmed_facts,
        supporting_evidence: item.supporting_evidence,
        contradicting_evidence: item.contradicting_evidence,
        likely_causes: item.likely_causes,
        unknowns: item.unknowns,
        unresolved_evidence_requirements: item.unresolved_evidence_requirements,
        requires_more_evidence_before_mitigation:
          item.requires_more_evidence_before_mitigation,
      },
    }));
  }

  private decisionEvents(decision: DecisionResult): IncidentEventInput[] {
    return decision.decisions.map((item) => ({
      incidentId: item.incident_id,
      title: item.title,
      stage: 'Decide' as const,
      message: `${item.disposition}: next=${item.next_stage}`,
      severity: item.severity,
      service: item.affected_services[0] ?? null,
      evidence: {
        disposition: item.disposition,
        next_stage: item.next_stage,
        rationale: item.rationale,
        evidence_to_pass: item.evidence_to_pass,
        follow_up_actions: item.follow_up_actions,
      },
    }));
  }

  private verificationEvents(verification: VerificationResult): IncidentEventInput[] {
    return verification.verifications.map((item) => ({
      incidentId: item.incident_id,
      title: item.title,
      stage: 'Verify' as const,
      message: `${item.status}: next=${item.recommended_next_stage}`,
      severity: item.severity,
      evidence: {
        status: item.status,
        rationale: item.rationale,
        checks: item.checks.map((check) => ({
          tool: check.tool,
          target: check.target,
          status: check.status,
          evidence: check.evidence,
        })),
      },
    }));
  }

  private async sendTransitionAlerts(
    runId: string | undefined,
    transitions: IncidentTransition[]
  ): Promise<void> {
    if (transitions.length === 0) {
      return;
    }

    try {
      await sendSlackAlerts(this.config, this.stateRepository, runId, transitions);
    } catch (error) {
      console.error('[Orchestrator] Alert delivery failed:', error);
    }
  }

  start(): void {
    if (this.intervalId) {
      console.warn('[Orchestrator] Already started');
      return;
    }

    console.log('[Orchestrator] Starting monitoring loop');
    console.log(`[Orchestrator] Interval: ${this.config.monitoring.intervalMs}ms`);
    console.log(`[Orchestrator] Model: ${this.config.openrouter.model}`);
    console.log(`[Orchestrator] S3 URI: ${this.config.healthReport.s3Uri}`);

    this.tick();

    this.intervalId = setInterval(() => {
      this.tick();
    }, this.config.monitoring.intervalMs);

    if (this.config.alarm.webhook.enabled && !this.triggerConsumerHandle) {
      const launcher: TriggerInvestigationLauncher = {
        isBusy: () => this.investigateBusy,
        launch: (batch) => this.runInvestigationFromTrigger(batch),
        verifyRecovery: (trigger, incident) =>
          this.runRecoveryVerifyFromTrigger(trigger, incident),
      };
      this.triggerConsumerHandle = startAlarmTriggerConsumer({
        config: this.config,
        repository: this.stateRepository,
        launcher,
      });
      console.log(
        `[Orchestrator] Alarm trigger consumer started (poll ${this.config.alarm.trigger.pollMs}ms)`
      );
    }
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[Orchestrator] Stopped monitoring loop');
    }
    if (this.triggerConsumerHandle) {
      this.triggerConsumerHandle.stop();
      this.triggerConsumerHandle = null;
    }
    void this.stateRepository.close?.();
  }

  private tick(): void {
    // Same cross-path mutex as runInvestigationFromTrigger: skip when an alarm-triggered
    // investigation is in flight, so scheduled and alarm paths cannot both be inside
    // persistClassification's load->reconcile->save cycle at once.
    if (this.classifyInFlight || this.investigateInFlight) {
      console.log(
        '[Orchestrator] Classify or Investigate stage still in flight, skipping tick'
      );
      return;
    }

    const input: StageInput = {
      stage: 'Classify',
      timestamp: new Date().toISOString(),
    };

    this.classifyInFlight = true;

    void this.runClassifyAsync(input);
  }

  private async runClassifyAsync(input: StageInput): Promise<void> {
    let runId: string | undefined;
    let reportFingerprint: string | undefined;
    let finished = false;

    const finishRun = async (update: {
      status: 'success' | 'skipped' | 'error';
      summary?: string;
      overallSeverity?: ClassificationResult['overall_severity'];
      errorMessage?: string;
    }): Promise<void> => {
      if (finished) {
        return;
      }
      finished = true;
      await this.stateRepository.finishRun?.(runId, {
        status: update.status,
        finishedAt: new Date().toISOString(),
        ...(reportFingerprint ? { reportHash: reportFingerprint } : {}),
        ...(update.summary ? { summary: update.summary } : {}),
        ...(update.overallSeverity ? { overallSeverity: update.overallSeverity } : {}),
        ...(update.errorMessage ? { errorMessage: update.errorMessage } : {}),
      });
    };

    try {
      console.log('[Orchestrator] Starting Classify stage');
      runId = await this.stateRepository.startRun?.(input.timestamp);
      const report = await fetchReport(
        this.config.healthReport.s3Uri,
        this.config.aws.region,
        this.config.timeouts.s3Ms
      );
      reportFingerprint = hashReportContent(report);
      const state = await this.stateRepository.load();

      if (hasProcessedReport(state, this.config.healthReport.s3Uri, reportFingerprint)) {
        console.log(
          `[Orchestrator] Report unchanged (${reportFingerprint.slice(0, 12)}); ` +
            'skipping Classify and Investigate'
        );
        // The report being unchanged says nothing about whether open incidents are still real,
        // so spend the tick re-verifying the ones nothing has touched in a while.
        const swept = await this.runStaleIncidentSweep(runId);
        await finishRun(
          swept > 0
            ? {
                status: 'success',
                summary: `Report unchanged; re-verified ${swept} stale incident(s).`,
              }
            : {
                status: 'skipped',
                summary: 'Report unchanged; skipped Classify and Investigate.',
              }
        );
        return;
      }

      const result = await classifyStage.runWithReport(input, this.config, report);

      if (result.status === 'success' && result.data) {
        console.log('[Orchestrator] Classify stage completed successfully');
        console.log(JSON.stringify(result.data, null, 2));

        const now = new Date().toISOString();
        recordProcessedReport(state, this.config.healthReport.s3Uri, reportFingerprint, now);
        const {
          classification,
          reconciliation,
          actionable,
        } = await this.persistClassification(runId, state, result.data as ClassificationResult, now);

        if (actionable && reconciliation.shouldInvestigate) {
          const downstreamSucceeded = await this.runInvestigate(classification, runId);
          if (!downstreamSucceeded) {
            await finishRun({
              status: 'error',
              summary: classification.summary,
              overallSeverity: classification.overall_severity,
              errorMessage: 'Investigate or Decide stage failed',
            });
            return;
          }
        } else if (actionable) {
          console.log(
            '[Orchestrator] Only recurring unchanged observations detected; skipping Investigate'
          );
        } else {
          console.log('[Orchestrator] No actionable incidents or findings; skipping Investigate');
        }

        await finishRun({
          status: 'success',
          summary: classification.summary,
          overallSeverity: classification.overall_severity,
        });
      } else if (result.status === 'error') {
        console.error('[Orchestrator] Classify stage failed:', result.error);
        await finishRun({
          status: 'error',
          errorMessage: result.error ?? 'Classify stage failed',
        });
      }
    } catch (error) {
      console.error('[Orchestrator] Unhandled error in Classify stage:', error);
      await finishRun({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.classifyInFlight = false;
    }
  }

  /**
   * Re-verifies open incidents that nothing has touched for `monitoring.sweep.staleAfterMs`.
   *
   * Classify is gated on the health report's content hash, so on a stable report the pipeline used
   * to do nothing at all — an incident could stay open for weeks with its last event being an
   * inconclusive Verify. This runs the same Verify stage against a decision synthesized from each
   * incident's stored decision, which is what actually produces the closure evidence
   * (VERIFIED_RECOVERED_TRANSIENT / VERIFIED_NON_INCIDENT) or proves the incident is still live.
   *
   * Bounded by `maxIncidents` per tick; because a swept incident records a fresh event, its
   * staleness clock resets and it will not be swept again until the threshold elapses.
   *
   * @returns how many incidents were verified.
   */
  private async runStaleIncidentSweep(runId: string | undefined): Promise<number> {
    const sweep = this.config.monitoring.sweep;
    if (!sweep.enabled || !this.stateRepository.findStaleIncidents) {
      return 0;
    }

    let stale: StaleIncidentRow[];
    try {
      stale = await this.stateRepository.findStaleIncidents(
        sweep.staleAfterMs,
        sweep.maxIncidents
      );
    } catch (error) {
      console.error('[Orchestrator] Stale incident lookup failed:', error);
      return 0;
    }

    if (stale.length === 0) {
      return 0;
    }

    console.log(
      `[Orchestrator] Sweeping ${stale.length} stale incident(s): ` +
        stale.map((row) => `${row.incidentId} (${row.state})`).join(', ')
    );

    const decision = this.sweepDecision(stale);
    try {
      const result = await verifyStage.run(
        { stage: 'Verify', timestamp: new Date().toISOString() },
        this.config,
        decision
      );
      if (result.status !== 'success' || !result.data) {
        console.error('[Orchestrator] Stale incident sweep verify failed:', result.error);
        return 0;
      }

      const verification = result.data as VerificationResult;
      await this.stateRepository.recordStageOutput?.(runId, {
        stage: 'Verify',
        data: verification,
      });
      const transitions =
        (await this.stateRepository.recordVerificationTransitions?.(runId, verification)) ?? [];
      await this.sendTransitionAlerts(runId, transitions);
      await this.stateRepository.recordIncidentEvents?.(
        runId,
        this.verificationEvents(verification)
      );
      console.log(
        `[Orchestrator] Stale incident sweep completed with ${verification.overall_status}`
      );
      return verification.verifications.length;
    } catch (error) {
      console.error('[Orchestrator] Stale incident sweep failed:', error);
      return 0;
    }
  }

  /**
   * Synthesizes the `DecisionResult` the Verify stage consumes from stored incident rows. The
   * stored decision's `evidence_to_pass` / `follow_up_actions` are carried over verbatim because
   * Verify scrapes them (see `extractAlarmNames`) to decide which alarms and services to check —
   * dropping them would leave the sweep with nothing concrete to verify.
   */
  private sweepDecision(stale: StaleIncidentRow[]): DecisionResult {
    return {
      summary: `Scheduled re-verification of ${stale.length} stale incident(s).`,
      overall_next_stage: 'Verify',
      handoff_notes: [
        'Health report content was unchanged; these incidents were re-verified because nothing ' +
          'had advanced them within the staleness threshold.',
      ],
      decisions: stale.map((row) => ({
        incident_id: row.incidentId,
        title: row.title,
        disposition: 'VERIFY' as const,
        next_stage: 'Verify' as const,
        severity: row.severity,
        affected_services: row.service ? [row.service] : [],
        rationale:
          `Stale ${row.state} incident with no activity since ${row.lastActivityAt ?? 'unknown'}; ` +
          're-checking current health signals before it is left open or closed.',
        evidence_to_pass: row.evidenceToPass,
        follow_up_actions: row.followUpActions,
      })),
    };
  }

  private logObservationReconciliation(reconciliation: ObservationReconciliation): void {
    const parts = [
      `${reconciliation.newObservations.length} new`,
      `${reconciliation.changedObservations.length} changed`,
      `${reconciliation.recurringObservations.length} recurring`,
      `${reconciliation.resolvedObservations.length} resolved`,
    ];
    console.log(`[Orchestrator] Observation state: ${parts.join(', ')}`);

    for (const observation of reconciliation.recurringObservations) {
      console.log(
        `[Orchestrator] Recurring ${observation.type}: "${observation.title}" ` +
          `(${observation.occurrences} occurrence(s), first seen ${observation.firstSeen})`
      );
    }

    for (const observation of reconciliation.resolvedObservations) {
      console.log(`[Orchestrator] Resolved ${observation.type}: "${observation.title}"`);
    }
  }

  private async runInvestigate(
    classification: ClassificationResult,
    runId: string | undefined,
    options: { guardAlreadyHeld?: boolean } = {}
  ): Promise<boolean> {
    const guardAlreadyHeld = options.guardAlreadyHeld ?? false;
    if (!guardAlreadyHeld) {
      if (this.investigateInFlight) {
        console.log('[Orchestrator] Investigate stage still in flight, skipping');
        return false;
      }
      this.investigateInFlight = true;
    }

    try {
      console.log('[Orchestrator] Starting Investigate stage');
      const input: StageInput = {
        stage: 'Investigate',
        timestamp: new Date().toISOString(),
      };

      const result = await investigateStage.run(input, this.config, classification);

      if (result.status === 'success' && result.data) {
        const data = result.data as InvestigationResult;
        console.log(
          `[Orchestrator] Investigate stage completed: ${data.overall_assessment} ` +
            `(severity ${data.overall_severity}, ${data.investigations.length} investigation(s))`
        );
        console.log(JSON.stringify(result.data, null, 2));
        await this.stateRepository.recordStageOutput?.(runId, {
          stage: 'Investigate',
          data,
        });
        await this.stateRepository.recordIncidentEvents?.(
          runId,
          this.investigationEvents(data)
        );
        return await this.runDecide(data, runId);
      } else if (result.status === 'error') {
        console.error('[Orchestrator] Investigate stage failed:', result.error);
        return false;
      }
    } catch (error) {
      console.error('[Orchestrator] Unhandled error in Investigate stage:', error);
      return false;
    } finally {
      if (!guardAlreadyHeld) {
        this.investigateInFlight = false;
      }
    }

    return false;
  }

  private async runDecide(
    investigation: InvestigationResult,
    runId: string | undefined
  ): Promise<boolean> {
    const input: StageInput = {
      stage: 'Decide',
      timestamp: new Date().toISOString(),
    };

    const result = await decideStage.run(input, investigation);

    if (result.status === 'success' && result.data) {
      const data = result.data as DecisionResult;
      console.log(
        `[Orchestrator] Decide stage completed: next=${data.overall_next_stage} ` +
          `(${data.decisions.length} decision(s))`
      );
      console.log(JSON.stringify(result.data, null, 2));
      await this.stateRepository.recordStageOutput?.(runId, {
        stage: 'Decide',
        data,
      });
      const transitions =
        (await this.stateRepository.recordDecisionTransitions?.(runId, data)) ?? [];
      await this.sendTransitionAlerts(runId, transitions);
      await this.stateRepository.recordDecisions?.(runId, data);
      await this.stateRepository.recordIncidentEvents?.(runId, this.decisionEvents(data));
      await this.runSelectedResponseStage(data, runId, investigation);
      return true;
    } else if (result.status === 'error') {
      console.error('[Orchestrator] Decide stage failed:', result.error);
      return false;
    }

    return false;
  }

  private async runSelectedResponseStage(
    decision: DecisionResult,
    runId: string | undefined,
    investigation: InvestigationResult
  ): Promise<void> {
    if (decision.overall_next_stage === 'None') {
      console.log('[Orchestrator] Decide selected no downstream response stage');
      return;
    }

    if (decision.overall_next_stage === 'Investigate') {
      console.log(
        '[Orchestrator] Decide requested further investigation; waiting for next report cycle'
      );
      return;
    }

    if (decision.overall_next_stage === 'Mitigate') {
      await this.runMitigate(decision, investigation, runId);
      return;
    }

    const input: StageInput = {
      stage: decision.overall_next_stage,
      timestamp: new Date().toISOString(),
    };
    const result = await verifyStage.run(input, this.config, decision);

    console.log(
      `[Orchestrator] ${result.stage} stage returned ${result.status}` +
        (result.data ? `: ${JSON.stringify(result.data)}` : '')
    );

    if (result.status === 'success' && result.data) {
      const verification = result.data as VerificationResult;
      await this.stateRepository.recordStageOutput?.(runId, {
        stage: 'Verify',
        data: verification,
      });
      const transitions =
        (await this.stateRepository.recordVerificationTransitions?.(runId, verification)) ?? [];
      await this.sendTransitionAlerts(runId, transitions);
      await this.stateRepository.recordIncidentEvents?.(
        runId,
        this.verificationEvents(verification)
      );

      // Verify is the second door into Mitigate: an incident Decide sent to Verify can come back
      // VERIFIED_ACTIVE_INCIDENT, which warrants a proposal. Scope the proposals to exactly the
      // incidents Verify confirmed active rather than to everything in the decision batch.
      const activeIncidentIds = verification.verifications
        .filter((item) => item.status === 'VERIFIED_ACTIVE_INCIDENT')
        .map((item) => item.incident_id);
      if (activeIncidentIds.length > 0) {
        await this.runMitigate(decision, investigation, runId, activeIncidentIds);
      }
    }
  }

  /**
   * Produces mitigation *proposals* and records them. Nothing here executes a change: the tool
   * layer is read-only, and a proposal's job is to reach a human with enough structure to be
   * approved or rejected quickly.
   */
  private async runMitigate(
    decision: DecisionResult,
    investigation: InvestigationResult,
    runId: string | undefined,
    incidentIds?: string[]
  ): Promise<void> {
    const result = await mitigateStage.run(
      { stage: 'Mitigate', timestamp: new Date().toISOString() },
      decision,
      investigation,
      {
        ...(incidentIds ? { incidentIds } : {}),
        region: this.config.aws.region,
      }
    );

    if (result.status !== 'success' || !result.data) {
      console.error('[Orchestrator] Mitigate stage failed:', result.error);
      return;
    }

    const mitigation = result.data as MitigationResult;
    console.log(`[Orchestrator] Mitigate stage completed: ${mitigation.summary}`);
    if (mitigation.proposals.length === 0) {
      return;
    }

    // Proposals get their own table (with an outcome lifecycle), so unlike the other stages there
    // is no raw-JSON column on `runs` to write; the incident_events row below is the run linkage.
    await this.stateRepository.recordMitigationProposals?.(runId, mitigation);
    await this.stateRepository.recordIncidentEvents?.(
      runId,
      this.mitigationEvents(mitigation)
    );

    try {
      await sendMitigationProposalAlerts(
        this.config,
        this.stateRepository,
        runId,
        mitigation.proposals
      );
    } catch (error) {
      console.error('[Orchestrator] Mitigation proposal alert delivery failed:', error);
    }
  }

  private mitigationEvents(mitigation: MitigationResult): IncidentEventInput[] {
    return mitigation.proposals.map((proposal) => ({
      incidentId: proposal.incident_id,
      title: proposal.title,
      stage: 'Mitigate' as const,
      message: `${proposal.action_kind.toUpperCase()} proposed: ${proposal.action}`,
      service: proposal.target.kind === 'unknown' ? null : proposal.target.identifier,
      evidence: {
        proposal,
      },
    }));
  }
}
