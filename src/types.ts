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

export type OverallAssessment =
  | 'ACTIVE_INCIDENT'
  | 'POSSIBLE_INCIDENT'
  | 'OBSERVABILITY_ISSUE'
  | 'NO_ACTIONABLE_INCIDENT'
  | 'INSUFFICIENT_EVIDENCE';

export type InvestigationStatus =
  | 'CONFIRMED_INCIDENT'
  | 'POSSIBLE_INCIDENT'
  | 'LIKELY_NON_INCIDENT'
  | 'OBSERVABILITY_GAP'
  | 'INSUFFICIENT_EVIDENCE';

export interface LikelyCause {
  cause: string;
  confidence: number;
  evidence: string[];
}

export interface AdditionalDataNeeded {
  data: string;
  reason: string;
  suggested_query_or_source: string;
}

export interface NextInvestigationStep {
  priority: number;
  action: string;
  expected_signal: string;
}

export interface PriorityItem {
  rank: number;
  incident_id: string;
  title: string;
  reason: string;
}

export interface Investigation {
  incident_id: string;
  title: string;
  original_classification: IncidentClassification;
  investigation_status: InvestigationStatus;
  severity: Severity;
  confidence: number;
  affected_services: string[];
  confirmed_facts: string[];
  supporting_evidence: string[];
  contradicting_evidence: string[];
  likely_causes: LikelyCause[];
  unknowns: string[];
  additional_data_needed: AdditionalDataNeeded[];
  recommended_next_investigation_steps: NextInvestigationStep[];
  requires_more_evidence_before_mitigation: boolean;
  possible_future_remediation: string[];
}

export interface InvestigationResult {
  summary: string;
  overall_assessment: OverallAssessment;
  overall_severity: Severity;
  investigations: Investigation[];
  cross_cutting_observations: string[];
  priority_order: PriorityItem[];
}

export type Stage = 'Classify' | 'Investigate' | 'Mitigate' | 'Restore' | 'Verify';

export interface ReportWindow {
  label: string;
  generatedAt?: string | undefined;
  startTime?: string | undefined;
  endTime?: string | undefined;
}

export interface StageInput {
  stage: Stage;
  timestamp: string;
  reportWindow?: ReportWindow | undefined;
}

export interface StageResult {
  stage: Stage;
  status: 'success' | 'error' | 'not_implemented';
  timestamp: string;
  data?: ClassificationResult | InvestigationResult | { message: string };
  error?: string;
}
