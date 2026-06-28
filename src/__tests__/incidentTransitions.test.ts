import { describe, expect, it } from 'vitest';
import type {
  DecisionNextStage,
  IncidentDecision,
  IncidentVerification,
  Severity,
} from '../types.js';
import type { PersistedIncidentSnapshot } from '../state/transitions.js';
import {
  transitionFromDecision,
  transitionFromVerification,
} from '../state/transitions.js';

function previous(
  overrides: Partial<PersistedIncidentSnapshot> = {}
): PersistedIncidentSnapshot {
  return {
    incidentId: 'INC-001',
    severity: 'MEDIUM',
    state: 'decision',
    currentDisposition: 'VERIFY',
    currentNextStage: 'Verify',
    closedAt: null,
    ...overrides,
  };
}

function decision(
  overrides: Partial<IncidentDecision> = {}
): IncidentDecision {
  return {
    incident_id: 'INC-001',
    title: 'High 4xx',
    disposition: 'VERIFY',
    next_stage: 'Verify',
    severity: 'MEDIUM',
    affected_services: ['data-pipeline-api'],
    rationale: 'Verify current health.',
    evidence_to_pass: ['e'],
    follow_up_actions: [],
    ...overrides,
  };
}

function verification(
  overrides: Partial<IncidentVerification> = {}
): IncidentVerification {
  return {
    incident_id: 'INC-001',
    title: 'High 4xx',
    status: 'STILL_INCONCLUSIVE',
    severity: 'MEDIUM',
    rationale: 'More evidence needed.',
    checks: [],
    recommended_next_stage: 'Investigate',
    ...overrides,
  };
}

describe('incident state transitions', () => {
  const decisionCases = [
    {
      name: 'new incident',
      previousSnapshot: undefined,
      decisionOverrides: {},
      transitionType: 'new_incident',
      alertable: true,
    },
    {
      name: 'severity increased',
      previousSnapshot: previous({ severity: 'LOW' }),
      decisionOverrides: { severity: 'HIGH' },
      transitionType: 'severity_increased',
      alertable: true,
    },
    {
      name: 'ready for mitigation',
      previousSnapshot: previous({ currentDisposition: 'VERIFY', currentNextStage: 'Verify' }),
      decisionOverrides: {
        disposition: 'MITIGATE',
        next_stage: 'Mitigate',
      },
      transitionType: 'ready_for_mitigation',
      alertable: true,
    },
    {
      name: 'recovered by decision',
      previousSnapshot: previous({ currentDisposition: 'VERIFY', currentNextStage: 'Verify' }),
      decisionOverrides: {
        disposition: 'CLOSE_TRANSIENT',
        next_stage: 'None',
      },
      transitionType: 'recovered',
      alertable: true,
    },
    {
      name: 'closed by decision',
      previousSnapshot: previous({ currentDisposition: 'VERIFY', currentNextStage: 'Verify' }),
      decisionOverrides: {
        disposition: 'CLOSE_NON_INCIDENT',
        next_stage: 'None',
      },
      transitionType: 'closed',
      alertable: true,
    },
    {
      name: 'identical decision',
      previousSnapshot: previous(),
      decisionOverrides: {},
      transitionType: 'unchanged',
      alertable: false,
    },
    {
      name: 'non-alertable investigation loop',
      previousSnapshot: previous({ currentDisposition: 'VERIFY', currentNextStage: 'Verify' }),
      decisionOverrides: {
        disposition: 'CONTINUE_INVESTIGATION',
        next_stage: 'Investigate',
      },
      transitionType: 'unchanged',
      alertable: false,
    },
  ] satisfies Array<{
    name: string;
    previousSnapshot: PersistedIncidentSnapshot | undefined;
    decisionOverrides: Partial<IncidentDecision>;
    transitionType: string;
    alertable: boolean;
  }>;

  it.each(decisionCases)('$name', ({ previousSnapshot, decisionOverrides, transitionType, alertable }) => {
    const result = transitionFromDecision(previousSnapshot, decision(decisionOverrides));

    expect(result.transitionType).toBe(transitionType);
    expect(result.alertable).toBe(alertable);
    expect(result.evidence).toMatchObject({
      transition_type: transitionType,
      alertable,
    });
  });

  it.each<{
    name: string;
    previousOverrides?: Partial<PersistedIncidentSnapshot>;
    status: IncidentVerification['status'];
    recommendedNextStage?: DecisionNextStage;
    severity?: Severity;
    transitionType: string;
    alertable: boolean;
  }>([
    {
      name: 'verified active',
      status: 'VERIFIED_ACTIVE_INCIDENT',
      recommendedNextStage: 'Mitigate',
      transitionType: 'verified_active',
      alertable: true,
    },
    {
      name: 'recovered',
      status: 'VERIFIED_RECOVERED_TRANSIENT',
      recommendedNextStage: 'None',
      transitionType: 'recovered',
      alertable: true,
    },
    {
      name: 'closed non incident',
      status: 'VERIFIED_NON_INCIDENT',
      recommendedNextStage: 'None',
      transitionType: 'closed',
      alertable: true,
    },
    {
      name: 'closed observability issue',
      status: 'VERIFIED_OBSERVABILITY_ISSUE',
      recommendedNextStage: 'None',
      transitionType: 'closed',
      alertable: true,
    },
    {
      name: 'inconclusive unchanged',
      status: 'STILL_INCONCLUSIVE',
      transitionType: 'unchanged',
      alertable: false,
    },
    {
      name: 'already closed remains unchanged',
      previousOverrides: { state: 'resolved', closedAt: '2026-06-08T10:30:00Z' },
      status: 'VERIFIED_RECOVERED_TRANSIENT',
      recommendedNextStage: 'None',
      transitionType: 'unchanged',
      alertable: false,
    },
  ])(
    '$name',
    ({
      previousOverrides,
      status,
      recommendedNextStage = 'Investigate',
      severity = 'MEDIUM',
      transitionType,
      alertable,
    }) => {
      const result = transitionFromVerification(
        previous(previousOverrides),
        verification({
          status,
          severity,
          recommended_next_stage: recommendedNextStage,
        })
      );

      expect(result.transitionType).toBe(transitionType);
      expect(result.alertable).toBe(alertable);
      expect(result.evidence).toMatchObject({
        transition_type: transitionType,
        alertable,
      });
    }
  );
});
