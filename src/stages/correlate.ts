import type {
  IncidentSemantics,
  Investigation,
  InvestigationResult,
  PriorityItem,
} from '../types.js';

const AUTH_DEGRADATION_RE = /auth[- ]?service|auth_call_failed|auth request timed out|auth service request timed out|slow api operation|usage debit rejected/i;
const CUSTOMER_5XX_RE = /\b5xx\b|\b50[0-9]\b|target-generated 503|customer[_ -]?5xx|server errors?/i;

function textOf(investigation: Investigation): string {
  return [
    investigation.title,
    investigation.original_classification,
    investigation.investigation_status,
    ...investigation.affected_services,
    ...investigation.confirmed_facts,
    ...investigation.supporting_evidence,
    ...investigation.contradicting_evidence,
    ...investigation.likely_causes.flatMap((cause) => [cause.cause, ...cause.evidence]),
  ].join(' ');
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}

function defaultSemantics(investigation: Investigation): IncidentSemantics {
  if (investigation.semantics) {
    return {
      ...investigation.semantics,
      upstream_incident_ids: [...investigation.semantics.upstream_incident_ids],
      downstream_incident_ids: [...investigation.semantics.downstream_incident_ids],
      observability_notes: [...investigation.semantics.observability_notes],
    };
  }

  return {
    customer_impact:
      investigation.investigation_status === 'CONFIRMED_INCIDENT'
        ? 'POSSIBLE_CUSTOMER_IMPACT'
        : 'UNKNOWN',
    evidence_role:
      investigation.investigation_status === 'LIKELY_NON_INCIDENT'
        ? 'NOISE_OR_NON_INCIDENT'
        : 'UNKNOWN',
    currentness: 'UNKNOWN',
    duplicate_of: null,
    root_incident_id: null,
    upstream_incident_ids: [],
    downstream_incident_ids: [],
    observability_reliability: 'UNKNOWN',
    observability_notes: [],
  };
}

function isCustomer5xxInvestigation(investigation: Investigation): boolean {
  return CUSTOMER_5XX_RE.test(textOf(investigation));
}

function isAuthInvestigation(investigation: Investigation): boolean {
  return AUTH_DEGRADATION_RE.test(textOf(investigation));
}

function sharesService(left: Investigation, right: Investigation): boolean {
  const rightServices = new Set(right.affected_services.map((service) => service.toLowerCase()));
  return left.affected_services.some((service) => rightServices.has(service.toLowerCase()));
}

function findCanonicalCustomerImpact(investigations: Investigation[]): Investigation | undefined {
  return investigations.find(
    (investigation) =>
      investigation.investigation_status === 'CONFIRMED_INCIDENT' &&
      isCustomer5xxInvestigation(investigation)
  );
}

function duplicateSummary(investigation: Investigation): string {
  const facts = [...investigation.confirmed_facts, ...investigation.supporting_evidence].slice(0, 3);
  return `Correlated duplicate evidence from ${investigation.incident_id} (${investigation.title}): ${facts.join(' ')}`;
}

function upstreamSummary(investigation: Investigation): string {
  const facts = [...investigation.confirmed_facts, ...investigation.supporting_evidence].slice(0, 3);
  return `Correlated upstream suspect ${investigation.incident_id} (${investigation.title}): ${facts.join(' ')}`;
}

function updatePriorityOrder(result: InvestigationResult, duplicateIds: Set<string>): PriorityItem[] {
  const existing = result.priority_order.filter((item) => !duplicateIds.has(item.incident_id));
  const known = new Set(existing.map((item) => item.incident_id));
  const additions = result.investigations
    .filter((investigation) => !duplicateIds.has(investigation.incident_id) && !known.has(investigation.incident_id))
    .map((investigation, index) => ({
      rank: existing.length + index + 1,
      incident_id: investigation.incident_id,
      title: investigation.title,
      reason: investigation.semantics?.evidence_role === 'UPSTREAM_SUSPECT'
        ? 'Correlated upstream suspect for the canonical customer-impact incident.'
        : 'Retained after incident correlation.',
    }));

  return [...existing, ...additions].map((item, index) => ({ ...item, rank: index + 1 }));
}

export function correlateInvestigations(result: InvestigationResult): InvestigationResult {
  const canonical = findCanonicalCustomerImpact(result.investigations);
  if (!canonical) {
    return {
      ...result,
      investigations: result.investigations.map((investigation) => ({
        ...investigation,
        semantics: defaultSemantics(investigation),
      })),
    };
  }

  const duplicateIds = new Set<string>();
  const upstreamIds = new Set<string>();
  const canonicalSupportingEvidence: string[] = [];

  const investigations = result.investigations.map((investigation) => {
    const semantics = defaultSemantics(investigation);

    if (investigation.incident_id === canonical.incident_id) {
      return {
        ...investigation,
        semantics: {
          ...semantics,
          customer_impact: 'CONFIRMED_CUSTOMER_IMPACT' as const,
          evidence_role: 'PRIMARY_INCIDENT' as const,
          root_incident_id: canonical.incident_id,
        },
      };
    }

    const duplicate =
      sharesService(investigation, canonical) &&
      isCustomer5xxInvestigation(investigation);
    if (duplicate) {
      duplicateIds.add(investigation.incident_id);
      canonicalSupportingEvidence.push(duplicateSummary(investigation));
      return {
        ...investigation,
        semantics: {
          ...semantics,
          customer_impact: 'CONFIRMED_CUSTOMER_IMPACT' as const,
          evidence_role: 'DUPLICATE_EVIDENCE' as const,
          duplicate_of: canonical.incident_id,
          root_incident_id: canonical.incident_id,
        },
      };
    }

    if (isAuthInvestigation(investigation) && AUTH_DEGRADATION_RE.test(textOf(canonical))) {
      upstreamIds.add(investigation.incident_id);
      canonicalSupportingEvidence.push(upstreamSummary(investigation));
      return {
        ...investigation,
        semantics: {
          ...semantics,
          evidence_role: 'UPSTREAM_SUSPECT' as const,
          root_incident_id: canonical.incident_id,
          downstream_incident_ids: unique([
            ...semantics.downstream_incident_ids,
            canonical.incident_id,
          ]),
        },
      };
    }

    return { ...investigation, semantics };
  });

  const correlated = investigations.map((investigation) => {
    if (investigation.incident_id !== canonical.incident_id) {
      return investigation;
    }

    const semantics = defaultSemantics(investigation);
    return {
      ...investigation,
      supporting_evidence: unique([
        ...investigation.supporting_evidence,
        ...canonicalSupportingEvidence,
      ]),
      semantics: {
        ...semantics,
        upstream_incident_ids: unique([
          ...semantics.upstream_incident_ids,
          ...upstreamIds,
        ]),
      },
    };
  });

  return {
    ...result,
    investigations: correlated,
    cross_cutting_observations: unique([
      ...result.cross_cutting_observations,
      ...(duplicateIds.size > 0 || upstreamIds.size > 0
        ? [
            `Incident correlation linked ${duplicateIds.size} duplicate evidence item(s) and ${upstreamIds.size} upstream suspect item(s) to ${canonical.incident_id}.`,
          ]
        : []),
    ]),
    priority_order: updatePriorityOrder({ ...result, investigations: correlated }, duplicateIds),
  };
}
