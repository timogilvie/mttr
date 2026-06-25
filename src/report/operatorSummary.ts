import type { DecisionResult, IncidentDecision, Investigation, InvestigationResult } from '../types.js';

export interface OperatorSummaryInput {
  investigation: InvestigationResult;
  decision?: DecisionResult | undefined;
}

const CUSTOMER_IMPACT_RE = /\b(5xx|503|customer|user|request|requests|endpoint|endpoints|impact)\b/i;
const RULED_OUT_RE = /\b(ALB|load balancer|ECS|task|tasks|deploy|deployment|rollout|crash|stopped)\b/i;
const OBSERVABILITY_RE = /\b(missing|no datapoints|treatMissingData|telemetry|alarm|metric|observability)\b/i;

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function firstMatching(lines: string[], pattern: RegExp): string | undefined {
  return lines.map(compact).find((line) => line.length > 0 && pattern.test(line));
}

function choosePrimaryInvestigation(investigations: Investigation[]): Investigation | undefined {
  return (
    investigations.find(
      (investigation) =>
        investigation.semantics?.customer_impact === 'CONFIRMED_CUSTOMER_IMPACT' &&
        investigation.semantics.evidence_role !== 'DUPLICATE_EVIDENCE'
    ) ??
    investigations.find(
      (investigation) =>
        investigation.investigation_status === 'CONFIRMED_INCIDENT' &&
        investigation.semantics?.evidence_role !== 'DUPLICATE_EVIDENCE'
    ) ??
    investigations.find(
      (investigation) => investigation.semantics?.evidence_role === 'PRIMARY_INCIDENT'
    ) ??
    investigations[0]
  );
}

function chooseLikelyRoot(investigations: Investigation[], primary: Investigation): string {
  const upstream = investigations.find(
    (investigation) => investigation.semantics?.evidence_role === 'UPSTREAM_SUSPECT'
  );

  if (upstream) {
    const cause = upstream.likely_causes[0]?.cause;
    return compact(cause ? `${upstream.title}: ${cause}` : upstream.title);
  }

  const cause = primary.likely_causes[0]?.cause;
  return compact(cause ?? primary.title);
}

function chooseDecision(decision: DecisionResult | undefined, investigation: Investigation): IncidentDecision | undefined {
  return decision?.decisions.find((candidate) => candidate.incident_id === investigation.incident_id);
}

function chooseNextAction(
  primary: Investigation,
  primaryDecision: IncidentDecision | undefined,
  decision: DecisionResult | undefined
): string {
  const action =
    primaryDecision?.follow_up_actions[0] ??
    decision?.decisions.find((candidate) => candidate.follow_up_actions.length > 0)
      ?.follow_up_actions[0] ??
    primary.recommended_next_investigation_steps.sort((a, b) => a.priority - b.priority)[0]?.action;

  return compact(action ?? 'No follow-up action was selected.');
}

function chooseObservabilityCaveat(investigations: Investigation[]): string {
  const observabilityInvestigation = investigations.find(
    (investigation) =>
      investigation.semantics?.evidence_role === 'OBSERVABILITY_FAILURE' ||
      investigation.semantics?.observability_reliability === 'UNRELIABLE' ||
      [...investigation.confirmed_facts, ...investigation.supporting_evidence].some((line) =>
        OBSERVABILITY_RE.test(line)
      )
  );

  if (!observabilityInvestigation) {
    return 'No major observability caveat identified.';
  }

  const notes = observabilityInvestigation.semantics?.observability_notes ?? [];
  const note = notes.find((line) => line.trim().length > 0);
  const evidence = firstMatching(
    [
      ...observabilityInvestigation.supporting_evidence,
      ...observabilityInvestigation.confirmed_facts,
      ...observabilityInvestigation.contradicting_evidence,
    ],
    OBSERVABILITY_RE
  );

  return compact(note ?? evidence ?? `${observabilityInvestigation.title} has unreliable observability evidence.`);
}

export function renderOperatorSummary(input: OperatorSummaryInput): string {
  const primary = choosePrimaryInvestigation(input.investigation.investigations);
  if (!primary) {
    return [
      '[Operator Summary]',
      `Status: ${input.investigation.overall_assessment} severity ${input.investigation.overall_severity}.`,
      'Confirmed impact: none identified.',
      'Likely root area: none identified.',
      'Ruled out: none identified.',
      'Observability caveat: no investigation evidence was available.',
      'Next action: no follow-up action was selected.',
    ].join('\n');
  }

  const primaryDecision = chooseDecision(input.decision, primary);
  const impact =
    firstMatching([...primary.confirmed_facts, ...primary.supporting_evidence], CUSTOMER_IMPACT_RE) ??
    primary.title;
  const ruledOut =
    firstMatching(primary.contradicting_evidence, RULED_OUT_RE) ??
    firstMatching(primary.supporting_evidence, /\bnot\b.*\b(ALB|ECS|deploy|deployment|task)\b/i) ??
    'No major alternate cause was ruled out.';

  return [
    '[Operator Summary]',
    `Status: ${input.investigation.overall_assessment} severity ${input.investigation.overall_severity}.`,
    `Confirmed impact: ${compact(impact)}`,
    `Likely root area: ${chooseLikelyRoot(input.investigation.investigations, primary)}`,
    `Ruled out: ${compact(ruledOut)}`,
    `Observability caveat: ${chooseObservabilityCaveat(input.investigation.investigations)}`,
    `Next action: ${chooseNextAction(primary, primaryDecision, input.decision)}`,
  ].join('\n');
}
