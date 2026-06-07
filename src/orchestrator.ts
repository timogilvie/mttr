import type { Config } from './config.js';
import type { StageInput, ClassificationResult, InvestigationResult } from './types.js';
import * as classifyStage from './stages/classify.js';
import * as investigateStage from './stages/investigate.js';

export class Orchestrator {
  private intervalId: NodeJS.Timeout | null = null;
  private classifyInFlight = false;
  private investigateInFlight = false;

  constructor(private readonly config: Config) {}

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
      const result = await classifyStage.run(input, this.config);

      if (result.status === 'success' && result.data) {
        console.log('[Orchestrator] Classify stage completed successfully');
        console.log(JSON.stringify(result.data, null, 2));

        const classification = result.data as ClassificationResult;
        const actionable =
          classification.incidents.length > 0 || classification.findings.length > 0;

        if (actionable) {
          await this.runInvestigate(classification);
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
      } else if (result.status === 'error') {
        console.error('[Orchestrator] Investigate stage failed:', result.error);
      }
    } catch (error) {
      console.error('[Orchestrator] Unhandled error in Investigate stage:', error);
    } finally {
      this.investigateInFlight = false;
    }
  }
}
