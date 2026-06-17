import type { Config } from './config.js';
import type { StageInput, ClassificationResult, InvestigationResult, DecisionResult } from './types.js';
import * as classifyStage from './stages/classify.js';
import * as investigateStage from './stages/investigate.js';
import * as decideStage from './stages/decide.js';
import * as verifyStage from './stages/verify.js';
import { mitigateStage } from './stages/stubs.js';
import { fetchReport } from './report/fetchReport.js';
import {
  hashReportContent,
  hasProcessedReport,
  loadAgentState,
  reconcileObservations,
  recordProcessedReport,
  saveAgentState,
  type ObservationReconciliation,
} from './state/agentState.js';

export class Orchestrator {
  private intervalId: NodeJS.Timeout | null = null;
  private classifyInFlight = false;
  private investigateInFlight = false;
  private readonly config: Config;

  constructor(config: Config) {
    this.config = structuredClone(config);
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
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[Orchestrator] Stopped monitoring loop');
    }
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
    try {
      console.log('[Orchestrator] Starting Classify stage');
      const report = await fetchReport(
        this.config.healthReport.s3Uri,
        this.config.aws.region,
        this.config.timeouts.s3Ms
      );
      const reportFingerprint = hashReportContent(report);
      const state = await loadAgentState(this.config.state.path);

      if (hasProcessedReport(state, this.config.healthReport.s3Uri, reportFingerprint)) {
        console.log(
          `[Orchestrator] Report unchanged (${reportFingerprint.slice(0, 12)}); ` +
            'skipping Classify and Investigate'
        );
        return;
      }

      const result = await classifyStage.runWithReport(input, this.config, report);

      if (result.status === 'success' && result.data) {
        console.log('[Orchestrator] Classify stage completed successfully');
        console.log(JSON.stringify(result.data, null, 2));

        const classification = result.data as ClassificationResult;
        const now = new Date().toISOString();
        recordProcessedReport(state, this.config.healthReport.s3Uri, reportFingerprint, now);
        const reconciliation = reconcileObservations(state, classification, now);
        await saveAgentState(this.config.state.path, state);
        this.logObservationReconciliation(reconciliation);

        const actionable =
          classification.incidents.length > 0 || classification.findings.length > 0;

        if (actionable && reconciliation.shouldInvestigate) {
          await this.runInvestigate(classification);
        } else if (actionable) {
          console.log(
            '[Orchestrator] Only recurring unchanged observations detected; skipping Investigate'
          );
        } else {
          console.log('[Orchestrator] No actionable incidents or findings; skipping Investigate');
        }
      } else if (result.status === 'error') {
        console.error('[Orchestrator] Classify stage failed:', result.error);
      }
    } catch (error) {
      console.error('[Orchestrator] Unhandled error in Classify stage:', error);
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

  private async runInvestigate(classification: ClassificationResult): Promise<void> {
    if (this.investigateInFlight) {
      console.log('[Orchestrator] Investigate stage still in flight, skipping');
      return;
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
        await this.runDecide(data);
      } else if (result.status === 'error') {
        console.error('[Orchestrator] Investigate stage failed:', result.error);
      }
    } catch (error) {
      console.error('[Orchestrator] Unhandled error in Investigate stage:', error);
    } finally {
      this.investigateInFlight = false;
    }
  }

  private async runDecide(investigation: InvestigationResult): Promise<void> {
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
      await this.runSelectedResponseStage(data);
    } else if (result.status === 'error') {
      console.error('[Orchestrator] Decide stage failed:', result.error);
    }
  }

  private async runSelectedResponseStage(decision: DecisionResult): Promise<void> {
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
      const verification = result.data;
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
