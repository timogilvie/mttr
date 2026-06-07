import { z } from 'zod';
import type { ClassificationResult } from '../types.js';

export const SeveritySchema = z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const IncidentClassificationSchema = z.enum([
  'DEPLOYMENT_REGRESSION',
  'RESOURCE_EXHAUSTION',
  'AUTH_FAILURE',
  'DATABASE_DEGRADATION',
  'EXTERNAL_DEPENDENCY_FAILURE',
  'CONFIGURATION_DRIFT',
  'NETWORK_CONNECTIVITY',
  'TRAFFIC_ANOMALY',
  'APPLICATION_ERROR',
  'BACKGROUND_JOB_FAILURE',
  'DATA_PIPELINE_FAILURE',
  'STORAGE_DEGRADATION',
  'CACHE_DEGRADATION',
  'RATE_LIMITING',
  'SECURITY_EVENT',
  'OBSERVABILITY_FAILURE',
  'UNKNOWN',
]);

const UserImpactSchema = z.enum(['NONE', 'MINIMAL', 'PARTIAL', 'SIGNIFICANT', 'COMPLETE']);

const IncidentSignalsSchema = z.object({
  alarms: z.array(z.string()),
  metrics: z.array(z.string()),
  logs: z.array(z.string()),
});

const InvestigationPlanSchema = z.object({
  priority: z.number(),
  estimated_user_impact: UserImpactSchema,
  first_actions: z.array(z.string()),
  questions_to_answer: z.array(z.string()),
  suggested_cloudwatch_queries: z.array(z.string()),
});

const IncidentSchema = z.object({
  incident_id: z.string(),
  title: z.string(),
  classification: IncidentClassificationSchema,
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1),
  affected_services: z.array(z.string()),
  evidence: z.array(z.string()),
  signals: IncidentSignalsSchema,
  suspected_causes: z.array(z.string()),
  investigation_plan: InvestigationPlanSchema,
  recommended_next_stage: z.string(),
});

const FindingSchema = z.object({
  title: z.string(),
  classification: IncidentClassificationSchema,
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1),
  affected_services: z.array(z.string()),
  evidence: z.array(z.string()),
  reason_not_incident: z.string(),
});

const ClassificationResultSchema = z.object({
  summary: z.string(),
  overall_severity: SeveritySchema,
  incidents: z.array(IncidentSchema),
  findings: z.array(FindingSchema),
});

export class ClassificationValidationError extends Error {
  constructor(message: string, public readonly zodError: z.ZodError) {
    const firstIssue = zodError.issues[0];
    const path = firstIssue ? firstIssue.path.join('.') : 'unknown';
    super(`${message} (first error at: ${path})`);
    this.name = 'ClassificationValidationError';
  }
}

export function parseClassification(data: unknown): ClassificationResult {
  const result = ClassificationResultSchema.safeParse(data);
  if (!result.success) {
    throw new ClassificationValidationError(
      'Invalid classification result',
      result.error
    );
  }
  return result.data;
}
