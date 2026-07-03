import type { Config } from './config.js';
import type {
  StageInput,
  ClassificationResult,
  InvestigationResult,
  DecisionResult,
  VerificationResult,
} from './types.js';
import * as classifyStage from './stages/classify.js';
import * as investigateStage from './stages/investigate.js';
import * as decideStage from './stages/decide.js';
import * as verifyStage from './stages/verify.js';
import { mitigateStage } from './stages/stubs.js';
import { sendSlackAlerts } from './alerts/slack.js';
import { fetchReport } from './report/fetchReport.js';
import { alarmSpecFromSns } from './report/alarmSpecFromSns.js';
import {
  buildMandatoryIncident,
  maxSeverity,
  specDedupeKey,
  type MandatoryIncidentSpec,
} from './report/mandatoryIncidents.js';
import {
  canonicalObservationKey,
  hashReportContent,
  hasProcessedReport,
  reconcileObservations,
  recordProcessedReport,
  type ObservationReconciliation,
} from './state/agentState.js';
import {
  createAgentStateRepository,
  type IncidentEventInput,
  type AgentStateRepository,
} from './state/repository.js';
import type { IncidentTransition } from './state/transitions.js';
import {
  startAlarmTriggerConsumer,
  type AlarmTriggerBatch,
  type AlarmTriggerConsumerHandle,
  type TriggerInvestigationLauncher,
  type TriggerLaunchResult,
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

function triggerStateChangeTime(trigger: AlarmTriggerBatch['triggers'][number]): string {
  return trigger.state_change_time instanceof Date
    ? trigger.state_change_time.toISOString()
    : trigger.state_change_time;
}

function bestSpecByDedupeKey(
  specs: MandatoryIncidentSpec[]
): MandatoryIncidentSpec[] {
  const byKey = new Map<string, MandatoryIncidentSpec>();
  for (const spec of specs) {
    const key = specDedupeKey(spec);
    const existing = byKey.get(key);
    if (!existing || maxSeverity(spec.severity, existing.severity) === spec.severity) {
      byKey.set(key, spec);
    }
  }
  return [...byKey.values()].sort((a, b) => specDedupeKey(a).localeCompare(specDedupeKey(b)));
}

function classificationFromAlarmSpecs(
  batch: AlarmTriggerBatch,
  specs: MandatoryIncidentSpec[]
): ClassificationResult {
  const incidents = specs.map((spec, index) => buildMandatoryIncident(spec, index));
  const highestSeverity = incidents.reduce(
    (severity, incident) => maxSeverity(severity, incident.severity),
    'NONE' as ClassificationResult['overall_severity']
  );
  const triggerWindow = batch.triggers
    .map(triggerStateChangeTime)
    .sort((a, b) => a.localeCompare(b));
  const firstChange = triggerWindow[0];
  const lastChange = triggerWindow.at(-1);

  return {
    summary: `Alarm-triggered investigation for ${incidents.length} incident signal(s).`,
    overall_severity: highestSeverity,
    incidents,
    findings: [],
    report_context:
      firstChange && lastChange
        ? {
            window_label: 'Alarm trigger batch',
            window_start: firstChange,
            window_end: lastChange,
          }
        : undefined,
  };
}

export class Orchestrator {
  private intervalId: NodeJS.Timeout | null = null;
  private classifyInFlight = false;
  private investigateInFlight = false;
  private readonly config: Config;
  private readonly stateRepository: AgentStateRepository;
  private triggerConsumerHandle: AlarmTriggerConsumerHandle | null = null;

  constructor(config: Config, stateRepository?: AgentStateRepository) {
    this.config = structuredClone(config);
    this.stateRepository = stateRepository ?? createAgentStateRepository(this.config);
  }

  /** Public read of the single-flight investigate guard — the T5 consumer's concurrency seam. */
  get investigateBusy(): boolean {
    return this.investigateInFlight;
  }

  async runInvestigationFromTrigger(batch: AlarmTriggerBatch): Promise<TriggerLaunchResult> {
    if (this.investigateInFlight) {
      return { status: 'busy' };
    }

    if (batch.triggers.length === 0) {
      return { status: 'error', message: 'No alarm triggers supplied' };
    }

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
      const parsedSpecs: MandatoryIncidentSpec[] = [];
      const invalidTriggers: string[] = [];
      for (const trigger of batch.triggers) {
        const parsed = alarmSpecFromSns(trigger.payload);
        if (parsed.ok) {
          parsedSpecs.push(parsed.spec);
        } else {
          invalidTriggers.push(`${trigger.id}:${parsed.reason}`);
        }
      }

      const specs = bestSpecByDedupeKey(parsedSpecs);
      if (specs.length === 0) {
        return {
          status: 'error',
          message:
            invalidTriggers.length > 0
              ? `No usable alarm specs in trigger batch (${invalidTriggers.join(', ')})`
              : 'No usable alarm specs in trigger batch',
        };
      }

      const startedAt = new Date().toISOString();
      runId = await this.stateRepository.startRun?.(startedAt, 'alarm');
      if (!runId) {
        return {
          status: 'error',
          message: 'Alarm-triggered investigations require a repository that records runs',
        };
      }

      const state = await this.stateRepository.load();
      const classification = canonicalizeClassificationIncidents(
        classificationFromAlarmSpecs(batch, specs)
      );
      const reconciliation = reconcileObservations(state, classification, startedAt);
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

      if (reconciliation.shouldInvestigate) {
        const downstreamSucceeded = await this.runInvestigate(classification, runId);
        if (!downstreamSucceeded) {
          await finishRun({
            status: 'error',
            summary: classification.summary,
            overallSeverity: classification.overall_severity,
            errorMessage: 'Investigate or Decide stage failed',
          });
          return {
            status: 'error',
            message: 'Investigate or Decide stage failed',
          };
        }
      } else {
        console.log(
          '[Orchestrator] Alarm observations are recurring unchanged; skipping Investigate'
        );
      }

      await finishRun({
        status: 'success',
        summary: classification.summary,
        overallSeverity: classification.overall_severity,
      });
      return { status: 'launched', runId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Orchestrator] Alarm-triggered investigation failed:', error);
      await finishRun({
        status: 'error',
        errorMessage: message,
      });
      return { status: 'error', message };
    }
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
    if (this.classifyInFlight) {
      console.log('[Orchestrator] Classify stage still in flight, skipping tick');
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
        await finishRun({
          status: 'skipped',
          summary: 'Report unchanged; skipped Classify and Investigate.',
        });
        return;
      }

      const result = await classifyStage.runWithReport(input, this.config, report);

      if (result.status === 'success' && result.data) {
        console.log('[Orchestrator] Classify stage completed successfully');
        console.log(JSON.stringify(result.data, null, 2));

        const classification = canonicalizeClassificationIncidents(
          result.data as ClassificationResult
        );
        const now = new Date().toISOString();
        recordProcessedReport(state, this.config.healthReport.s3Uri, reportFingerprint, now);
        const reconciliation = reconcileObservations(state, classification, now);
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

        const actionable =
          classification.incidents.length > 0 || classification.findings.length > 0;

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
    runId: string | undefined
  ): Promise<boolean> {
    if (this.investigateInFlight) {
      console.log('[Orchestrator] Investigate stage still in flight, skipping');
      return false;
    }

    this.investigateInFlight = true;

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
      this.investigateInFlight = false;
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
      await this.runSelectedResponseStage(data, runId);
      return true;
    } else if (result.status === 'error') {
      console.error('[Orchestrator] Decide stage failed:', result.error);
      return false;
    }

    return false;
  }

  private async runSelectedResponseStage(
    decision: DecisionResult,
    runId: string | undefined
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

    const input: StageInput = {
      stage: decision.overall_next_stage,
      timestamp: new Date().toISOString(),
    };

    const result =
      decision.overall_next_stage === 'Mitigate'
        ? await mitigateStage(input, decision)
        : await verifyStage.run(input, this.config, decision);

    console.log(
      `[Orchestrator] ${result.stage} stage returned ${result.status}` +
        (result.data ? `: ${JSON.stringify(result.data)}` : '')
    );

    if (result.stage === 'Verify' && result.status === 'success' && result.data) {
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
      if (
        'overall_next_stage' in verification &&
        verification.overall_next_stage === 'Mitigate'
      ) {
        const mitigationInput: StageInput = {
          stage: 'Mitigate',
          timestamp: new Date().toISOString(),
        };
        const mitigation = await mitigateStage(mitigationInput, decision);
        console.log(
          `[Orchestrator] ${mitigation.stage} stage returned ${mitigation.status}` +
            (mitigation.data ? `: ${JSON.stringify(mitigation.data)}` : '')
        );
      }
    }
  }
}
