import type {
  CausalEvidence,
  DecisionResult,
  IncidentDecision,
  Investigation,
  InvestigationResult,
  LikelyCause,
  MitigationActionKind,
  MitigationCheckSpec,
  MitigationConfidence,
  MitigationProposal,
  MitigationResult,
  MitigationReversibility,
  MitigationTarget,
  StageInput,
  StageResult,
} from '../types.js';
import { extractAlarmNames } from './verify.js';

/**
 * Mitigate turns an investigation into a *proposal*: a specific, reviewable recommendation with
 * the blast radius, rollback path and success signal a human needs to approve or reject it.
 *
 * It executes nothing. The tool layer this agent ships with is read-only by construction, and that
 * property is the main thing keeping an LLM-driven incident responder safe to run against
 * production. Proposals are delivered for human action instead.
 *
 * The derivation here is deliberately deterministic. The Investigate stage already produces the
 * hard parts — ranked causes with confidence, change correlation, resource saturation, task health
 * — so the first version maps those to structure rather than asking a model to re-reason about
 * them. Where it cannot determine something (most often the concrete target resource) it says so
 * in `preconditions` rather than guessing, which is what makes the output safe to read literally.
 */

const REVERSIBILITY: Record<MitigationActionKind, MitigationReversibility> = {
  rollback: 'manual',
  restart: 'trivial',
  scale: 'trivial',
  config_change: 'manual',
  credential_rotation: 'manual',
  dependency_failover: 'manual',
  instrumentation: 'manual',
  no_action: 'trivial',
  other: 'manual',
};

const AUTH_FAILURE_RE =
  /\b(401|403|unauthorized|forbidden|credential|credentials|api[- ]?key|token|permission denied|expired|signature)\b/i;
const RESTART_RE = /\b(no healthy tasks|running=0|crash ?loop|oom|killed|restart|unhealthy task)\b/i;

function causeCorpus(investigation: Investigation): string {
  return [
    investigation.title,
    ...investigation.confirmed_facts,
    ...investigation.supporting_evidence,
    ...investigation.likely_causes.map((cause) => cause.cause),
    ...investigation.likely_causes.flatMap((cause) => cause.evidence),
    investigation.causal_evidence?.first_bad_source ?? '',
  ].join('\n');
}

function topCause(investigation: Investigation): LikelyCause | null {
  return (
    [...investigation.likely_causes].sort((a, b) => b.confidence - a.confidence)[0] ?? null
  );
}

/**
 * Ordered most-specific first. A correlated deploy outranks the symptom pattern because rolling
 * back a bad release addresses the symptom too, whereas the reverse is not true.
 */
function deriveActionKind(
  investigation: Investigation,
  causal: CausalEvidence | undefined
): MitigationActionKind {
  if (investigation.investigation_status === 'LIKELY_NON_INCIDENT') {
    return 'no_action';
  }
  if (investigation.likely_causes.length === 0) {
    return 'no_action';
  }
  if (investigation.original_classification === 'OBSERVABILITY_FAILURE') {
    return 'instrumentation';
  }

  if (causal?.change_correlation.some((event) => event.type === 'deploy')) {
    return 'rollback';
  }

  const corpus = causeCorpus(investigation);
  if (investigation.original_classification === 'AUTH_FAILURE' || AUTH_FAILURE_RE.test(corpus)) {
    return 'credential_rotation';
  }
  if ((causal?.task_health?.stopped_task_count ?? 0) > 0 || RESTART_RE.test(corpus)) {
    return 'restart';
  }
  if (
    (causal?.resource_saturation?.length ?? 0) > 0 ||
    investigation.original_classification === 'RESOURCE_EXHAUSTION'
  ) {
    return 'scale';
  }
  if (investigation.original_classification === 'EXTERNAL_DEPENDENCY_FAILURE') {
    return 'dependency_failover';
  }
  if (
    investigation.original_classification === 'CONFIGURATION_DRIFT' ||
    causal?.change_correlation.some((event) => event.type === 'config')
  ) {
    return 'config_change';
  }

  return 'other';
}

function firstMatch(corpus: string, pattern: RegExp): string | null {
  const match = corpus.match(pattern);
  // Identifiers are frequently at the end of a sentence ("...the Lambda function foo."), so strip
  // trailing sentence punctuation the greedy character class pulled in.
  return match?.[1]?.trim().replace(/[.,;:)]+$/, '') ?? null;
}

function deriveTarget(investigation: Investigation, region: string | undefined): MitigationTarget {
  const corpus = causeCorpus(investigation);
  const scope = region ? { region } : {};

  const lambda =
    firstMatch(corpus, /\/aws\/lambda\/([A-Za-z0-9_.-]+)/) ??
    firstMatch(corpus, /\bLambda function ([A-Za-z0-9_.-]+)/i);
  if (lambda) {
    return { kind: 'lambda_function', identifier: lambda, ...scope };
  }

  const ecs = firstMatch(corpus, /\bECS service (?:is )?`?([A-Za-z0-9_.-]+)`?/i);
  if (ecs) {
    return { kind: 'ecs_service', identifier: ecs, ...scope };
  }

  const rule = firstMatch(corpus, /\bEventBridge rule ([A-Za-z0-9_.-]+)/i);
  if (rule) {
    return { kind: 'eventbridge_rule', identifier: rule, ...scope };
  }

  return {
    kind: 'unknown',
    identifier: investigation.affected_services[0] ?? 'unknown',
    ...scope,
  };
}

function confidenceFromCause(cause: LikelyCause | null): MitigationConfidence {
  if (!cause) {
    return 'low';
  }
  if (cause.confidence >= 0.8) {
    return 'high';
  }
  return cause.confidence >= 0.5 ? 'medium' : 'low';
}

function actionSentence(
  kind: MitigationActionKind,
  target: MitigationTarget,
  investigation: Investigation
): string {
  // The Investigate prompt already parks remediation ideas in `possible_future_remediation`,
  // "labelled as a possibility, never an instruction". That prose is better than anything a
  // template produces, so prefer it and let the derived fields supply the structure around it.
  const suggested = investigation.possible_future_remediation.find(
    (item) => item.trim() !== ''
  );
  if (kind !== 'no_action' && suggested) {
    return suggested.trim();
  }

  const name = target.identifier;
  switch (kind) {
    case 'rollback':
      return `Roll ${name} back to the last known-good release.`;
    case 'restart':
      return `Restart or force a new deployment of ${name} to replace unhealthy tasks.`;
    case 'scale':
      return `Increase the capacity or resource limits for ${name}.`;
    case 'config_change':
      return `Revert the configuration drift affecting ${name}.`;
    case 'credential_rotation':
      return `Rotate or repair the credential ${name} uses for its failing downstream call.`;
    case 'dependency_failover':
      return `Fail ${name} over to a healthy dependency endpoint, or apply the documented degraded mode.`;
    case 'instrumentation':
      return `Restore the missing telemetry for ${name} so this signal becomes observable.`;
    case 'no_action':
      return 'No mitigation action recommended.';
    case 'other':
      return `Review ${name} and select a mitigation; the evidence does not map to a standard action.`;
  }
}

function blastRadius(kind: MitigationActionKind, investigation: Investigation): string {
  const services = investigation.affected_services.join(', ') || 'the affected service';
  switch (kind) {
    case 'rollback':
      return `${services} is redeployed; in-flight requests may fail during the swap and any change shipped after the last known-good release is reverted.`;
    case 'restart':
      return `${services} loses its current tasks while replacements start; expect a brief capacity dip.`;
    case 'scale':
      return `${services} capacity and cost change. No request path is interrupted.`;
    case 'config_change':
      return `${services} picks up new configuration, which may require a restart to take effect.`;
    case 'credential_rotation':
      return `Every consumer of the rotated credential is affected, not just ${services}.`;
    case 'dependency_failover':
      return `${services} traffic moves to a different dependency; behaviour and latency may change.`;
    case 'instrumentation':
      return 'No production behaviour changes; only telemetry coverage does.';
    case 'no_action':
      return 'None.';
    case 'other':
      return `Unknown until a specific action is chosen for ${services}.`;
  }
}

function rollbackPlan(kind: MitigationActionKind, target: MitigationTarget): string[] {
  switch (kind) {
    case 'rollback':
      return [`Redeploy the release that was live on ${target.identifier} before this rollback.`];
    case 'restart':
      return ['No rollback needed; if replacements fail to start, investigate task start failures before retrying.'];
    case 'scale':
      return [`Return ${target.identifier} to its previous capacity or resource limits.`];
    case 'config_change':
      return [`Re-apply the previous configuration for ${target.identifier}.`];
    case 'credential_rotation':
      return [
        'Keep the previous credential valid until the new one is confirmed working, then revoke it.',
      ];
    case 'dependency_failover':
      return [`Point ${target.identifier} back at the original dependency endpoint.`];
    case 'instrumentation':
      return ['Remove the added telemetry if it proves noisy or costly.'];
    case 'no_action':
      return [];
    case 'other':
      return ['Define a rollback path before acting.'];
  }
}

function preconditions(
  kind: MitigationActionKind,
  target: MitigationTarget,
  investigation: Investigation
): string[] {
  const rows: string[] = [];

  if (target.kind === 'unknown' && kind !== 'no_action') {
    rows.push(
      `Identify the concrete runtime resource behind "${target.identifier}" — the investigation ` +
        'evidence did not name one, so this proposal cannot be executed as written.'
    );
  }
  if (investigation.requires_more_evidence_before_mitigation) {
    rows.push(
      'The investigation flagged that more evidence is wanted before mitigating; confirm the ' +
        'cause below still holds before acting.'
    );
  }
  if (kind === 'rollback') {
    rows.push('Confirm the last known-good release and that rolling back does not drop a needed fix.');
  }
  if (kind === 'credential_rotation') {
    rows.push('Confirm which credential the failing call uses and who else consumes it.');
  }
  if (kind === 'scale') {
    rows.push('Confirm the saturation reading is current, not from the historical report window.');
  }

  return rows;
}

/**
 * Names the Verify-stage checks that would show the mitigation worked, up front, so approval and
 * confirmation use the same definition of success. Reuses `extractAlarmNames` so the alarms named
 * here are exactly the ones Verify would re-check.
 */
function successSignal(
  kind: MitigationActionKind,
  decision: IncidentDecision,
  investigation: Investigation
): { description: string; checks: MitigationCheckSpec[] } {
  const checks: MitigationCheckSpec[] = [
    ...extractAlarmNames(decision).map((alarm) => ({ tool: 'find_alarms', target: alarm })),
    ...investigation.affected_services.map((service) => ({
      tool: 'get_ecs_service_events',
      target: service,
    })),
  ];

  if (kind === 'no_action') {
    return {
      description: 'Nothing to confirm; no action is proposed.',
      checks: [],
    };
  }

  const description =
    kind === 'instrumentation'
      ? 'The previously missing metric reports datapoints, and alarm coverage exists for it.'
      : 'The failing signal that opened this incident clears and stays clear across a full check cycle.';

  return { description, checks: checks.slice(0, 6) };
}

function evidenceGaps(investigation: Investigation): string[] {
  const gaps = investigation.unresolved_evidence_requirements.map((requirement) =>
    requirement.tool_hint
      ? `${requirement.description} (run: ${requirement.tool_hint})`
      : requirement.description
  );
  if (investigation.requires_more_evidence_before_mitigation && gaps.length === 0) {
    gaps.push('The investigation wants more evidence before mitigation but did not say which.');
  }
  return gaps;
}

function buildProposal(
  decision: IncidentDecision,
  investigation: Investigation,
  region: string | undefined
): MitigationProposal {
  const causal = investigation.causal_evidence;
  const kind = deriveActionKind(investigation, causal);
  const target = deriveTarget(investigation, region);
  const cause = topCause(investigation);

  return {
    incident_id: decision.incident_id,
    title: decision.title,
    action: actionSentence(kind, target, investigation),
    action_kind: kind,
    target,
    addresses_cause:
      cause?.cause ??
      (kind === 'no_action'
        ? 'No root-cause hypothesis was recorded, so there is nothing to act on.'
        : 'No ranked root cause was recorded.'),
    cause_confidence: cause?.confidence ?? null,
    evidence_refs: [...(cause?.evidence ?? []), ...investigation.confirmed_facts].slice(0, 8),
    proposal_confidence: investigation.mitigation_confidence ?? confidenceFromCause(cause),
    evidence_gaps: evidenceGaps(investigation),
    preconditions: preconditions(kind, target, investigation),
    rollback_plan: rollbackPlan(kind, target),
    blast_radius: blastRadius(kind, investigation),
    reversibility: REVERSIBILITY[kind],
    success_signal: successSignal(kind, decision, investigation),
    requires_human_approval: true,
  };
}

export interface MitigateOptions {
  /**
   * Restricts proposals to these incidents. Used by the post-Verify entry point, where the
   * decisions were routed to Verify and it is Verify's VERIFIED_ACTIVE_INCIDENT results that
   * select which incidents now warrant a proposal.
   */
  incidentIds?: string[];
  region?: string | undefined;
}

export function mitigate(
  decision: DecisionResult,
  investigation: InvestigationResult,
  options: MitigateOptions = {}
): MitigationResult {
  const byIncidentId = new Map(
    investigation.investigations.map((item) => [item.incident_id, item])
  );
  const selected = options.incidentIds
    ? new Set(options.incidentIds)
    : null;

  const candidates = decision.decisions.filter((item) =>
    selected ? selected.has(item.incident_id) : item.next_stage === 'Mitigate'
  );

  const proposals: MitigationProposal[] = [];
  for (const item of candidates) {
    const match = byIncidentId.get(item.incident_id);
    if (!match) {
      // Without the investigation there are no ranked causes or causal evidence to build on, and
      // a proposal assembled from the decision alone would be speculation wearing structure.
      console.warn(
        `[Mitigate] No investigation found for ${item.incident_id}; skipping proposal`
      );
      continue;
    }
    proposals.push(buildProposal(item, match, options.region));
  }

  const actionable = proposals.filter((proposal) => proposal.action_kind !== 'no_action');
  return {
    summary:
      proposals.length === 0
        ? 'No incidents required a mitigation proposal.'
        : `Proposed ${actionable.length} mitigation(s) for human review across ${proposals.length} incident(s).`,
    proposals,
  };
}

export async function run(
  input: StageInput,
  decision: DecisionResult,
  investigation: InvestigationResult,
  options: MitigateOptions = {}
): Promise<StageResult> {
  return {
    stage: 'Mitigate',
    status: 'success',
    timestamp: input.timestamp,
    data: mitigate(decision, investigation, options),
  };
}
