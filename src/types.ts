export type Severity = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type IncidentClassification =
  | 'DEPLOYMENT_REGRESSION'
  | 'RESOURCE_EXHAUSTION'
  | 'AUTH_FAILURE'
  | 'DATABASE_DEGRADATION'
  | 'EXTERNAL_DEPENDENCY_FAILURE'
  | 'CONFIGURATION_DRIFT'
  | 'NETWORK_CONNECTIVITY'
  | 'TRAFFIC_ANOMALY'
  | 'APPLICATION_ERROR'
  | 'BACKGROUND_JOB_FAILURE'
  | 'DATA_PIPELINE_FAILURE'
  | 'STORAGE_DEGRADATION'
  | 'CACHE_DEGRADATION'
  | 'RATE_LIMITING'
  | 'SECURITY_EVENT'
  | 'OBSERVABILITY_FAILURE'
  | 'UNKNOWN';

export type UserImpact = 'NONE' | 'MINIMAL' | 'PARTIAL' | 'SIGNIFICANT' | 'COMPLETE';

export interface IncidentSignals {
  alarms: string[];
  metrics: string[];
  logs: string[];
}

export interface InvestigationPlan {
  priority: number;
  estimated_user_impact: UserImpact;
  first_actions: string[];
  questions_to_answer: string[];
  suggested_cloudwatch_queries: string[];
}

export interface Incident {
  incident_id: string;
  title: string;
  classification: IncidentClassification;
  severity: Severity;
  confidence: number;
  affected_services: string[];
  evidence: string[];
  signals: IncidentSignals;
  suspected_causes: string[];
  investigation_plan: InvestigationPlan;
  recommended_next_stage: string;
}

export interface Finding {
  title: string;
  classification: IncidentClassification;
  severity: Severity;
  confidence: number;
  affected_services: string[];
  evidence: string[];
  reason_not_incident: string;
}

export interface ClassificationResult {
  summary: string;
  overall_severity: Severity;
  incidents: Incident[];
  findings: Finding[];
}

export type Stage = 'Classify' | 'Investigate' | 'Mitigate' | 'Restore' | 'Verify';

export interface StageInput {
  stage: Stage;
  timestamp: string;
}

export interface StageResult {
  stage: Stage;
  status: 'success' | 'error' | 'not_implemented';
  timestamp: string;
  data?: ClassificationResult | { message: string };
  error?: string;
}
