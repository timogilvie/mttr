import { z } from 'zod';
import type { MitigationProposal } from '../types.js';

/**
 * Proposals are built deterministically today, so this schema exists to guard the *storage*
 * boundary rather than an LLM boundary: `mitigation_proposals.proposal_json` is jsonb written by
 * one deploy and read by another, and the API renders it to operators. Parsing on read means a
 * shape change shows up as a rejected row instead of a half-rendered recommendation.
 */
export const MitigationActionKindSchema = z.enum([
  'rollback',
  'restart',
  'scale',
  'config_change',
  'credential_rotation',
  'dependency_failover',
  'instrumentation',
  'no_action',
  'other',
]);

export const MitigationReversibilitySchema = z.enum(['trivial', 'manual', 'irreversible']);

export const MitigationTargetKindSchema = z.enum([
  'ecs_service',
  'lambda_function',
  'load_balancer',
  'eventbridge_rule',
  'log_group',
  'alarm',
  'unknown',
]);

const MitigationConfidenceSchema = z.enum(['high', 'medium', 'low']);

const MitigationTargetSchema = z.object({
  kind: MitigationTargetKindSchema,
  identifier: z.string(),
  region: z.string().optional(),
});

const MitigationCheckSpecSchema = z.object({
  tool: z.string(),
  target: z.string(),
});

const MitigationSuccessSignalSchema = z.object({
  description: z.string(),
  checks: z.array(MitigationCheckSpecSchema).default([]),
});

export const MitigationProposalSchema = z.object({
  incident_id: z.string(),
  title: z.string(),
  action: z.string(),
  action_kind: MitigationActionKindSchema,
  target: MitigationTargetSchema,
  addresses_cause: z.string(),
  cause_confidence: z.number().min(0).max(1).nullable(),
  evidence_refs: z.array(z.string()).default([]),
  proposal_confidence: MitigationConfidenceSchema,
  evidence_gaps: z.array(z.string()).default([]),
  preconditions: z.array(z.string()).default([]),
  rollback_plan: z.array(z.string()).default([]),
  blast_radius: z.string(),
  reversibility: MitigationReversibilitySchema,
  success_signal: MitigationSuccessSignalSchema,
  // Never accept a stored proposal that claims it does not need approval.
  requires_human_approval: z.literal(true),
});

export function parseMitigationProposal(data: unknown): MitigationProposal | null {
  const result = MitigationProposalSchema.safeParse(data);
  return result.success ? (result.data as MitigationProposal) : null;
}
