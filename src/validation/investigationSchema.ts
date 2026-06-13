import { z } from 'zod';
import type { InvestigationResult } from '../types.js';
import { SeveritySchema, IncidentClassificationSchema } from './classificationSchema.js';

const OverallAssessmentSchema = z.enum([
  'ACTIVE_INCIDENT',
  'POSSIBLE_INCIDENT',
  'OBSERVABILITY_ISSUE',
  'NO_ACTIONABLE_INCIDENT',
  'INSUFFICIENT_EVIDENCE',
]);

const InvestigationStatusSchema = z.enum([
  'CONFIRMED_INCIDENT',
  'POSSIBLE_INCIDENT',
  'LIKELY_NON_INCIDENT',
  'OBSERVABILITY_GAP',
  'INSUFFICIENT_EVIDENCE',
]);

const ConfidenceSchema = z.number().min(0).max(1);

const LikelyCauseSchema = z.object({
  cause: z.string(),
  confidence: ConfidenceSchema,
  evidence: z.array(z.string()),
});

const AdditionalDataNeededSchema = z.object({
  data: z.string(),
  reason: z.string(),
  suggested_query_or_source: z.string(),
});

const NextInvestigationStepSchema = z.object({
  priority: z.number(),
  action: z.string(),
  expected_signal: z.string(),
});

const EvidenceRequirementTypeSchema = z.enum([
  'CUSTOM_METRIC_HISTORY',
  'FIRST_BAD_LOG_TIMESTAMP',
  'LAMBDA_FAILURE_SUMMARY',
  'CHANGE_EVENT_DETAILS',
  'DEPLOYMENT_PROVENANCE',
  'ALARM_COVERAGE',
]);

const UnresolvedEvidenceRequirementSchema = z.object({
  type: EvidenceRequirementTypeSchema,
  description: z.string(),
  tool_hint: z.string(),
});

const PriorityItemSchema = z.object({
  rank: z.number(),
  incident_id: z.string(),
  title: z.string(),
  reason: z.string(),
});

const InvestigationSchema = z.object({
  incident_id: z.string(),
  title: z.string(),
  original_classification: IncidentClassificationSchema,
  investigation_status: InvestigationStatusSchema,
  severity: SeveritySchema,
  confidence: ConfidenceSchema,
  affected_services: z.array(z.string()),
  confirmed_facts: z.array(z.string()),
  supporting_evidence: z.array(z.string()),
  contradicting_evidence: z.array(z.string()),
  likely_causes: z.array(LikelyCauseSchema),
  unknowns: z.array(z.string()),
  additional_data_needed: z.array(AdditionalDataNeededSchema),
  unresolved_evidence_requirements: z.array(UnresolvedEvidenceRequirementSchema).default([]),
  recommended_next_investigation_steps: z.array(NextInvestigationStepSchema),
  requires_more_evidence_before_mitigation: z.boolean(),
  possible_future_remediation: z.array(z.string()),
});

const InvestigationResultSchema = z.object({
  summary: z.string(),
  overall_assessment: OverallAssessmentSchema,
  overall_severity: SeveritySchema,
  investigations: z.array(InvestigationSchema),
  cross_cutting_observations: z.array(z.string()),
  priority_order: z.array(PriorityItemSchema),
});

export class InvestigationValidationError extends Error {
  constructor(message: string, public readonly zodError: z.ZodError) {
    const firstIssue = zodError.issues[0];
    const path = firstIssue ? firstIssue.path.join('.') : 'unknown';
    super(`${message} (first error at: ${path})`);
    this.name = 'InvestigationValidationError';
  }
}

export function parseInvestigation(data: unknown): InvestigationResult {
  const result = InvestigationResultSchema.safeParse(data);
  if (!result.success) {
    throw new InvestigationValidationError(
      'Invalid investigation result',
      result.error
    );
  }
  return result.data;
}
