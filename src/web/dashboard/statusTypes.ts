import type { MitigationProposal, MitigationOutcome } from '../../types.js';
import type { Severity } from '../../types.js';

export type DashboardStatus = 'green' | 'yellow' | 'red';

export interface RunSummary {
  id: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: string;
  triggerSource?: 'scheduled' | 'alarm';
  healthReportS3Uri: string;
  reportHash: string | null;
  summary: string | null;
  overallSeverity: Severity | null;
  errorMessage: string | null;
}

export interface RunDetail extends RunSummary {
  raw: {
    classification: unknown;
    investigation: unknown;
    decision: unknown;
    verification: unknown;
  };
}

export interface WorkerHeartbeat {
  workerId: string;
  processName: string;
  lastSeenAt: string | null;
  metadata: Record<string, unknown> | null;
}

export interface IncidentSummary {
  incidentId: string;
  title: string;
  service: string | null;
  severity: Severity;
  state: string;
  openedAt: string | null;
  closedAt: string | null;
  /** Newest stage event for this incident; how an operator spots a stalled investigation. */
  lastActivityAt?: string | null;
  currentDisposition: string | null;
  currentNextStage: string | null;
  lastRunId: string | null;
}

export interface TransitionEvent {
  id: string;
  incidentId: string;
  runId: string | null;
  stage: string;
  message: string;
  severity: Severity | null;
  evidence: Record<string, unknown> | null;
  createdAt: string | null;
}

export interface AlertSummary {
  id: string;
  incidentId: string;
  runId: string | null;
  channel: string;
  sentAt: string | null;
  dedupeKey: string;
  payload: Record<string, unknown> | null;
}

export interface StatusResponse {
  status: DashboardStatus;
  lastRun: RunSummary | null;
  workerHeartbeat: WorkerHeartbeat | null;
  stale: {
    worker: boolean;
    report: boolean;
  };
  openIncidentCounts: Partial<Record<Severity, number>>;
  openIncidents: IncidentSummary[];
  /**
   * Incidents whose signal stopped appearing in the health report without anything verifying
   * recovery. Deliberately separate from `openIncidents`: they are not proven fixed, so they
   * must not vanish, but they are also not evidence that something is currently broken.
   */
  absentUnverifiedIncidents?: IncidentSummary[];
  recentTransitions: TransitionEvent[];
}

export interface MitigationProposalSummary {
  id: string;
  incidentId: string;
  runId: string | null;
  createdAt: string | null;
  outcome: MitigationOutcome;
  outcomeAt: string | null;
  outcomeNote: string | null;
  proposal: MitigationProposal | null;
}

export interface IncidentDetailResponse {
  incident: IncidentSummary;
  events: TransitionEvent[];
  alerts: AlertSummary[];
  mitigationProposals?: MitigationProposalSummary[];
}

export interface RunDetailResponse {
  run: RunDetail;
  incidents: IncidentSummary[];
}
