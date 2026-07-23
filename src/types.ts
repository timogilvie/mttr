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

export type CustomerImpactStatus =
  | 'NONE'
  | 'POSSIBLE_CUSTOMER_IMPACT'
  | 'CONFIRMED_CUSTOMER_IMPACT'
  | 'NOT_CUSTOMER_IMPACT'
  | 'UNKNOWN';

export type EvidenceRole =
  | 'PRIMARY_INCIDENT'
  | 'DUPLICATE_EVIDENCE'
  | 'UPSTREAM_SUSPECT'
  | 'DOWNSTREAM_SYMPTOM'
  | 'OBSERVABILITY_FAILURE'
  | 'NOISE_OR_NON_INCIDENT'
  | 'UNKNOWN';

export type SignalCurrentness =
  | 'ACTIVE'
  | 'RECOVERED_TRANSIENT'
  | 'HISTORICAL'
  | 'STALE'
  | 'UNKNOWN';

export type ObservabilityReliability =
  | 'TRUSTED'
  | 'PARTIAL'
  | 'UNRELIABLE'
  | 'UNKNOWN';

export interface IncidentSemantics {
  customer_impact: CustomerImpactStatus;
  evidence_role: EvidenceRole;
  currentness: SignalCurrentness;
  duplicate_of?: string | null | undefined;
  root_incident_id?: string | null | undefined;
  upstream_incident_ids: string[];
  downstream_incident_ids: string[];
  observability_reliability: ObservabilityReliability;
  observability_notes: string[];
}

export interface IncidentSignals {
  alarms: string[];
  metrics: string[];
  logs: string[];
  cloudwatch_metrics?: CloudWatchMetricSignal[] | undefined;
}

export interface MetricDimension {
  name: string;
  value: string;
}

export interface CloudWatchMetricSignal {
  namespace: string;
  metric_name: string;
  dimensions: MetricDimension[];
  stat?: 'Average' | 'Sum' | 'Minimum' | 'Maximum' | 'SampleCount' | undefined;
  label?: string | undefined;
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
  /**
   * Stable identifier for the underlying monitored signal (see `state/signalKey.ts`). Titles are
   * LLM prose and drift between reports; this is what incident identity is keyed on.
   */
  signal_key?: string | undefined;
  classification: IncidentClassification;
  severity: Severity;
  confidence: number;
  affected_services: string[];
  evidence: string[];
  signals: IncidentSignals;
  semantics?: IncidentSemantics | undefined;
  suspected_causes: string[];
  investigation_plan: InvestigationPlan;
  recommended_next_stage: string;
}

export interface Finding {
  title: string;
  /** See `Incident.signal_key`. */
  signal_key?: string | undefined;
  classification: IncidentClassification;
  severity: Severity;
  confidence: number;
  affected_services: string[];
  evidence: string[];
  semantics?: IncidentSemantics | undefined;
  reason_not_incident: string;
}

export interface ClassificationResult {
  summary: string;
  overall_severity: Severity;
  incidents: Incident[];
  findings: Finding[];
  report_context?: ReportContext | undefined;
}

export interface ReportContext {
  window_label?: string | undefined;
  generated_at?: string | undefined;
  window_start?: string | undefined;
  window_end?: string | undefined;
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

export type EvidenceRequirementType =
  | 'CUSTOM_METRIC_HISTORY'
  | 'FIRST_BAD_LOG_TIMESTAMP'
  | 'LAMBDA_FAILURE_SUMMARY'
  | 'CHANGE_EVENT_DETAILS'
  | 'DEPLOYMENT_PROVENANCE'
  | 'ALARM_COVERAGE';

export interface UnresolvedEvidenceRequirement {
  type: EvidenceRequirementType;
  description: string;
  tool_hint: string;
}

export interface PriorityItem {
  rank: number;
  incident_id: string;
  title: string;
  reason: string;
}

export type FailureConcentrationDimension =
  | 'endpoint'
  | 'method'
  | 'statusCode'
  | 'resourceId'
  | 'logStream';

export interface FailureConcentrationValue {
  value: string;
  count: number;
}

export interface FailureConcentration {
  dimension: FailureConcentrationDimension;
  values: FailureConcentrationValue[];
}

export type ChangeEventType = 'deploy' | 'config' | 'runtime' | 'other';

export interface ChangeCorrelationEvent {
  type: ChangeEventType;
  timestamp: string;
  description: string;
}

export interface TaskHealthFinding {
  summary: string;
  stopped_task_count?: number | undefined;
  details: string[];
}

export interface ResourceSaturationFinding {
  resource: string;
  metric: string;
  summary: string;
}

export type DependencyHealthStatus = 'healthy' | 'degraded' | 'unknown';

export interface DependencyHealthFinding {
  dependency: string;
  status: DependencyHealthStatus;
  summary: string;
}

export interface CausalEvidence {
  performed: boolean;
  failure_concentration?: FailureConcentration | undefined;
  first_bad_timestamp?: string | null | undefined;
  first_bad_source?: string | undefined;
  change_correlation: ChangeCorrelationEvent[];
  task_health?: TaskHealthFinding | undefined;
  resource_saturation: ResourceSaturationFinding[];
  dependency_health: DependencyHealthFinding[];
  found: string[];
  missing: string[];
  next_highest_value_query: string;
}

export type MitigationConfidence = 'high' | 'medium' | 'low';

export type TelemetryGapKind = 'instrumentation' | 'discovery' | 'runtime' | 'unknown';

export type TelemetryFallbackOutcome = 'resolved' | 'empty' | 'error';

export type TelemetryFallbackPath =
  | 'metric_exact_discovery'
  | 'metric_widened_lookback'
  | 'alarm_configuration'
  | 'runtime_owner_discovery'
  | 'log_group_retry';

export interface TelemetryFallbackAttempt {
  path: TelemetryFallbackPath;
  query: string;
  outcome: TelemetryFallbackOutcome;
  detail: string;
  next_source?: string | undefined;
}

export interface TelemetryGap {
  kind: TelemetryGapKind;
  next_telemetry_source: string;
  fallback_attempts: TelemetryFallbackAttempt[];
  reason?: string | undefined;
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
  semantics?: IncidentSemantics | undefined;
  likely_causes: LikelyCause[];
  unknowns: string[];
  additional_data_needed: AdditionalDataNeeded[];
  unresolved_evidence_requirements: UnresolvedEvidenceRequirement[];
  recommended_next_investigation_steps: NextInvestigationStep[];
  requires_more_evidence_before_mitigation: boolean;
  possible_future_remediation: string[];
  causal_evidence?: CausalEvidence | undefined;
  mitigation_confidence?: MitigationConfidence | undefined;
  confidence_justification?: string | undefined;
  telemetry_fallbacks?: TelemetryFallbackAttempt[] | undefined;
  telemetry_gap?: TelemetryGap | undefined;
}

export interface InvestigationResult {
  summary: string;
  overall_assessment: OverallAssessment;
  overall_severity: Severity;
  investigations: Investigation[];
  cross_cutting_observations: string[];
  priority_order: PriorityItem[];
}

export type DecisionDisposition =
  | 'MITIGATE'
  | 'VERIFY'
  | 'CONTINUE_INVESTIGATION'
  | 'OPEN_OBSERVABILITY_FOLLOWUP'
  | 'CLOSE_TRANSIENT'
  | 'CLOSE_NON_INCIDENT';

export type DecisionNextStage = 'Investigate' | 'Mitigate' | 'Verify' | 'None';

export interface IncidentDecision {
  incident_id: string;
  title: string;
  disposition: DecisionDisposition;
  next_stage: DecisionNextStage;
  severity: Severity;
  affected_services: string[];
  rationale: string;
  evidence_to_pass: string[];
  follow_up_actions: string[];
}

export interface DecisionResult {
  summary: string;
  overall_next_stage: DecisionNextStage;
  decisions: IncidentDecision[];
  handoff_notes: string[];
}

export type VerificationStatus =
  | 'VERIFIED_ACTIVE_INCIDENT'
  | 'VERIFIED_RECOVERED_TRANSIENT'
  | 'VERIFIED_OBSERVABILITY_ISSUE'
  | 'VERIFIED_NON_INCIDENT'
  | 'STILL_INCONCLUSIVE';

export interface VerificationCheck {
  tool: string;
  target: string;
  status: 'passed' | 'failed' | 'warning' | 'inconclusive';
  evidence: string;
}

export interface IncidentVerification {
  incident_id: string;
  title: string;
  status: VerificationStatus;
  severity: Severity;
  rationale: string;
  checks: VerificationCheck[];
  recommended_next_stage: DecisionNextStage;
}

export interface VerificationResult {
  summary: string;
  overall_status: VerificationStatus;
  overall_next_stage: DecisionNextStage;
  verifications: IncidentVerification[];
}

export type Stage = 'Classify' | 'Investigate' | 'Decide' | 'Mitigate' | 'Restore' | 'Verify';

export interface StageInput {
  stage: Stage;
  timestamp: string;
}

export interface StageResult {
  stage: Stage;
  status: 'success' | 'error' | 'not_implemented';
  timestamp: string;
  data?: ClassificationResult | InvestigationResult | DecisionResult | VerificationResult | { message: string };
  error?: string;
}
