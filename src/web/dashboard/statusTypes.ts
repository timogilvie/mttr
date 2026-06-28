import type { Severity } from '../../types.js';

export type DashboardStatus = 'green' | 'yellow' | 'red';

export interface RunSummary {
  id: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: string;
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
  recentTransitions: TransitionEvent[];
}

export interface IncidentDetailResponse {
  incident: IncidentSummary;
  events: TransitionEvent[];
  alerts: AlertSummary[];
}

export interface RunDetailResponse {
  run: RunDetail;
  incidents: IncidentSummary[];
}
