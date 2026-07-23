import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { IncidentDetail } from '../web/dashboard/IncidentDetail.js';
import type { IncidentDetailResponse } from '../web/dashboard/statusTypes.js';

function detail(overrides: Partial<IncidentDetailResponse> = {}): IncidentDetailResponse {
  return {
    incident: {
      incidentId: 'finding-abc123',
      title: 'High 4xx',
      service: 'data-pipeline-api',
      severity: 'HIGH',
      state: 'decision',
      openedAt: new Date().toISOString(),
      closedAt: null,
      currentDisposition: 'MITIGATE',
      currentNextStage: 'Mitigate',
      lastRunId: 'run-1',
    },
    events: [
      {
        id: 'classify-1',
        incidentId: 'finding-abc123',
        runId: 'run-1',
        stage: 'Classify',
        message: 'APPLICATION_ERROR: High 4xx',
        severity: 'HIGH',
        evidence: {
          classification: 'APPLICATION_ERROR',
          evidence: ['4xx spike'],
          semantics: {
            upstream_of: ['auth-service'],
            duplicate_of: 'INC-000',
          },
        },
        createdAt: new Date().toISOString(),
      },
      {
        id: 'investigate-1',
        incidentId: 'finding-abc123',
        runId: 'run-1',
        stage: 'Investigate',
        message: 'POSSIBLE_INCIDENT: High 4xx',
        severity: 'HIGH',
        evidence: { supporting_evidence: ['ALB access logs show 502s'] },
        createdAt: new Date().toISOString(),
      },
      {
        id: 'decide-1',
        incidentId: 'finding-abc123',
        runId: 'run-1',
        stage: 'Decide',
        message: 'Ready for mitigation: High 4xx',
        severity: 'HIGH',
        evidence: { transition_type: 'ready_for_mitigation', disposition: 'MITIGATE' },
        createdAt: new Date().toISOString(),
      },
      {
        id: 'verify-1',
        incidentId: 'finding-abc123',
        runId: 'run-1',
        stage: 'Verify',
        message: 'VERIFIED_ACTIVE_INCIDENT: next=Mitigate',
        severity: 'HIGH',
        evidence: {
          status: 'VERIFIED_ACTIVE_INCIDENT',
          checks: [{ tool: 'find_alarms', target: 'api', status: 'failed' }],
        },
        createdAt: new Date().toISOString(),
      },
    ],
    alerts: [
      {
        id: 'alert-1',
        incidentId: 'finding-abc123',
        runId: 'run-1',
        channel: 'slack',
        sentAt: new Date().toISOString(),
        dedupeKey: 'slack:finding-abc123:ready_for_mitigation:HIGH:MITIGATE',
        payload: { text: 'Ready for mitigation' },
      },
    ],
    ...overrides,
  };
}

describe('incident detail', () => {
  it('renders an active ready-for-mitigation incident timeline', () => {
    const html = renderToStaticMarkup(<IncidentDetail data={detail()} />);

    expect(html).toContain('finding-abc123');
    expect(html).toContain('Ready');
    expect(html).toContain('Operator Readout');
    expect(html).toContain('Action needed');
    expect(html).toContain('Closure Gate');
    expect(html).toContain('4xx spike');
    expect(html).toContain('upstream_of: auth-service');
    expect(html).toContain('duplicate_of: INC-000');
    expect(html).toContain('find_alarms api');
    expect(html).toContain('slack:finding-abc123');
    expect(html).toContain('href="/runs/run-1"');
  });

  it('renders a recovered timeline', () => {
    const html = renderToStaticMarkup(
      <IncidentDetail
        data={detail({
          incident: {
            ...detail().incident,
            severity: 'LOW',
            state: 'resolved',
            currentDisposition: 'CLOSE_TRANSIENT',
            currentNextStage: 'None',
            closedAt: new Date().toISOString(),
          },
          events: [
            {
              id: 'recover-1',
              incidentId: 'finding-abc123',
              runId: 'run-2',
              stage: 'Verify',
              message: 'Recovered transient incident: High 4xx',
              severity: 'LOW',
              evidence: { transition_type: 'recovered' },
              createdAt: new Date().toISOString(),
            },
          ],
        })}
      />
    );

    expect(html).toContain('resolved');
    expect(html).toContain('Closed');
    expect(html).toContain('Recovered transient incident');
  });

  it('renders why an inconclusive incident remains open and what to check next', () => {
    const html = renderToStaticMarkup(
      <IncidentDetail
        data={detail({
          incident: {
            ...detail().incident,
            title: 'High detector errors in deltaone-anomaly-detection',
            state: 'open',
            currentDisposition: 'CONTINUE_INVESTIGATION',
            currentNextStage: 'Investigate',
            closedAt: null,
          },
          events: [
            {
              id: 'investigate-2',
              incidentId: 'finding-abc123',
              runId: 'run-5',
              stage: 'Investigate',
              message: 'POSSIBLE_INCIDENT: High detector errors',
              severity: 'HIGH',
              evidence: {
                confirmed_facts: ['670 detector errors observed'],
                supporting_evidence: ['Auth errors occur during the RPC block-number call'],
                unresolved_evidence_requirements: [
                  {
                    description: 'Confirm whether RPC authorization failures are still occurring',
                    tool_hint: 'Query detector Lambda logs for authorization errors',
                  },
                ],
              },
              createdAt: new Date().toISOString(),
            },
            {
              id: 'decide-2',
              incidentId: 'finding-abc123',
              runId: 'run-5',
              stage: 'Decide',
              message: 'CONTINUE_INVESTIGATION: next=Investigate',
              severity: 'HIGH',
              evidence: {
                disposition: 'CONTINUE_INVESTIGATION',
                next_stage: 'Investigate',
                rationale: 'Incident is confirmed, but root-cause evidence is not sufficient for mitigation.',
                follow_up_actions: ['Check the downstream RPC/API credentials and authorization policy'],
              },
              createdAt: new Date().toISOString(),
            },
          ],
        })}
      />
    );

    expect(html).toContain('Still open');
    expect(html).toContain('Needs more evidence before closure');
    expect(html).toContain('Check the downstream RPC/API credentials');
    expect(html).toContain('670 detector errors observed');
    expect(html).toContain('RPC block-number call');
    // The evidence gap is shown once, with the tool call that would close it.
    expect(html).toContain('Open Evidence Gaps');
    expect(html).toContain('Run: Query detector Lambda logs for authorization errors');
  });

  it('surfaces the investigation root-cause hypotheses and their confidence', () => {
    const html = renderToStaticMarkup(
      <IncidentDetail
        data={detail({
          events: [
            {
              id: 'investigate-3',
              incidentId: 'finding-abc123',
              runId: 'run-7',
              stage: 'Investigate',
              message: 'POSSIBLE_INCIDENT: High detector errors',
              severity: 'MEDIUM',
              evidence: {
                likely_causes: [
                  {
                    cause: 'Transient downstream auth failure on the detector RPC call path.',
                    confidence: 0.86,
                    evidence: ['659 repeated 403 errors'],
                  },
                ],
              },
              createdAt: new Date().toISOString(),
            },
          ],
        })}
      />
    );

    expect(html).toContain('Likely Causes');
    expect(html).toContain('Transient downstream auth failure on the detector RPC call path.');
    expect(html).toContain('confidence 0.86');
  });

  it('offers the markdown handoff brief and shows how stale the incident is', () => {
    const html = renderToStaticMarkup(<IncidentDetail data={detail()} />);

    expect(html).toContain('Copy handoff');
    expect(html).toContain('href="/api/incidents/finding-abc123/brief"');
    expect(html).toContain('Last activity');
  });

  it('describes an absent incident as unverified rather than resolved', () => {
    const html = renderToStaticMarkup(
      <IncidentDetail
        data={detail({
          incident: {
            ...detail().incident,
            state: 'absent_unverified',
            closedAt: null,
            currentDisposition: null,
            currentNextStage: null,
          },
        })}
      />
    );

    expect(html).toContain('Absent, not verified');
    expect(html).toContain('Absence from a report is not evidence of a fix.');
  });

  it('renders the current mitigation proposal and states nothing was executed', () => {
    const html = renderToStaticMarkup(
      <IncidentDetail
        data={detail({
          mitigationProposals: [
            {
              id: 'prop-1',
              incidentId: 'finding-abc123',
              runId: 'run-1',
              createdAt: new Date().toISOString(),
              outcome: 'proposed',
              outcomeAt: null,
              outcomeNote: null,
              proposal: {
                incident_id: 'finding-abc123',
                title: 'High 4xx',
                action: 'Roll data-pipeline-api back to the last known-good release.',
                action_kind: 'rollback',
                target: { kind: 'ecs_service', identifier: 'data-pipeline-api' },
                addresses_cause: 'A bad deploy introduced the 5xx responses.',
                cause_confidence: 0.82,
                evidence_refs: ['5xx started at the deploy timestamp.'],
                proposal_confidence: 'high',
                evidence_gaps: [],
                preconditions: ['Confirm the last known-good release.'],
                rollback_plan: ['Redeploy the current release if the rollback regresses.'],
                blast_radius: 'data-pipeline-api is redeployed; in-flight requests may fail.',
                reversibility: 'manual',
                success_signal: {
                  description: 'The 5xx signal clears and stays clear.',
                  checks: [{ tool: 'find_alarms', target: 'api-5xx' }],
                },
                requires_human_approval: true,
              },
            },
          ],
        })}
      />
    );

    expect(html).toContain('Proposed Mitigation');
    expect(html).toContain('needs human approval');
    expect(html).toContain('Roll data-pipeline-api back to the last known-good release.');
    expect(html).toContain('Nothing has been executed');
    expect(html).toContain('Confirm the last known-good release.');
    expect(html).toContain('in-flight requests may fail');
  });

  it('does not render a proposal panel once the proposal is superseded', () => {
    const html = renderToStaticMarkup(
      <IncidentDetail
        data={detail({
          mitigationProposals: [
            {
              id: 'prop-old',
              incidentId: 'finding-abc123',
              runId: 'run-1',
              createdAt: new Date().toISOString(),
              outcome: 'superseded',
              outcomeAt: new Date().toISOString(),
              outcomeNote: null,
              proposal: {
                incident_id: 'finding-abc123',
                title: 'High 4xx',
                action: 'Old action.',
                action_kind: 'restart',
                target: { kind: 'ecs_service', identifier: 'data-pipeline-api' },
                addresses_cause: 'x',
                cause_confidence: null,
                evidence_refs: [],
                proposal_confidence: 'low',
                evidence_gaps: [],
                preconditions: [],
                rollback_plan: [],
                blast_radius: 'x',
                reversibility: 'trivial',
                success_signal: { description: 'x', checks: [] },
                requires_human_approval: true,
              },
            },
          ],
        })}
      />
    );

    expect(html).not.toContain('Proposed Mitigation');
  });

  it('renders an observability-gap timeline', () => {
    const html = renderToStaticMarkup(
      <IncidentDetail
        data={detail({
          incident: {
            ...detail().incident,
            title: 'Missing detector liveness metric',
            severity: 'MEDIUM',
            currentDisposition: 'OPEN_OBSERVABILITY_FOLLOWUP',
            currentNextStage: 'None',
          },
          events: [
            {
              id: 'obs-1',
              incidentId: 'finding-abc123',
              runId: 'run-3',
              stage: 'Verify',
              message: 'Closed after verification: Missing detector liveness metric',
              severity: 'MEDIUM',
              evidence: { status: 'VERIFIED_OBSERVABILITY_ISSUE', transition_type: 'closed' },
              createdAt: new Date().toISOString(),
            },
          ],
        })}
      />
    );

    expect(html).toContain('Missing detector liveness metric');
    expect(html).toContain('OPEN_OBSERVABILITY_FOLLOWUP');
    expect(html).toContain('VERIFIED_OBSERVABILITY_ISSUE');
  });

  it('renders a non-incident closed timeline', () => {
    const html = renderToStaticMarkup(
      <IncidentDetail
        data={detail({
          incident: {
            ...detail().incident,
            title: 'Expected deploy noise',
            severity: 'NONE',
            state: 'resolved',
            currentDisposition: 'CLOSE_NON_INCIDENT',
            currentNextStage: 'None',
          },
          events: [
            {
              id: 'non-incident-1',
              incidentId: 'finding-abc123',
              runId: 'run-4',
              stage: 'Decide',
              message: 'Closed non-incident: Expected deploy noise',
              severity: 'NONE',
              evidence: { transition_type: 'closed', disposition: 'CLOSE_NON_INCIDENT' },
              createdAt: new Date().toISOString(),
            },
          ],
        })}
      />
    );

    expect(html).toContain('Expected deploy noise');
    expect(html).toContain('CLOSE_NON_INCIDENT');
    expect(html).toContain('Closed non-incident');
  });
});
