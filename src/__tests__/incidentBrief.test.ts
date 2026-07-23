import { describe, expect, it } from 'vitest';
import { buildIncidentBrief } from '../web/dashboard/incidentBrief.js';
import type { IncidentSummary, TransitionEvent } from '../web/dashboard/statusTypes.js';

const NOW = new Date('2026-07-23T10:00:00Z');

function incident(overrides: Partial<IncidentSummary> = {}): IncidentSummary {
  return {
    incidentId: 'finding-3',
    title: 'High detector errors in deltaone-anomaly-detection',
    service: 'deltaone-anomaly-detection',
    severity: 'MEDIUM',
    state: 'open',
    openedAt: '2026-07-14T10:25:58Z',
    closedAt: null,
    lastActivityAt: '2026-07-14T10:25:58Z',
    currentDisposition: 'VERIFY',
    currentNextStage: 'Verify',
    lastRunId: 'run-9',
    ...overrides,
  };
}

/** Modelled on the real event shape the deployed pipeline writes for this incident. */
function events(): TransitionEvent[] {
  return [
    {
      id: 'investigate-1',
      incidentId: 'finding-3',
      runId: 'run-9',
      stage: 'Investigate',
      message: 'POSSIBLE_INCIDENT: High detector errors',
      severity: 'MEDIUM',
      evidence: {
        confirmed_facts: ['670 detector errors reported'],
        likely_causes: [
          {
            cause: 'Transient downstream auth failure on the detector RPC call path.',
            confidence: 0.86,
            evidence: ['659 repeated 403 errors followed by 26 401 errors'],
          },
          { cause: 'Missing liveness instrumentation.', confidence: 0.4, evidence: [] },
        ],
        unresolved_evidence_requirements: [
          {
            type: 'LAMBDA_FAILURE_SUMMARY',
            description: 'Need error-context rows that include the remote URL or credential source.',
            tool_hint: 'query_logs on /aws/lambda/hokusai-deltaone-anomaly-detector-development',
          },
        ],
      },
      createdAt: '2026-07-14T10:25:58Z',
    },
    {
      id: 'verify-1',
      incidentId: 'finding-3',
      runId: 'run-9',
      stage: 'Verify',
      message: 'STILL_INCONCLUSIVE: next=Investigate',
      severity: 'MEDIUM',
      evidence: {
        status: 'STILL_INCONCLUSIVE',
        rationale: 'Verification could not prove recovery.',
        checks: [
          {
            tool: 'find_alarms',
            target: 'coverage',
            status: 'inconclusive',
            evidence: 'No alarms found for search "coverage"',
          },
        ],
      },
      createdAt: '2026-07-14T10:25:58Z',
    },
  ];
}

describe('incident brief', () => {
  it('carries the root-cause hypotheses and their confidence scores', () => {
    const brief = buildIncidentBrief({ incident: incident(), events: events(), now: NOW });

    expect(brief).toContain('## Likely causes');
    expect(brief).toContain('Transient downstream auth failure on the detector RPC call path.');
    expect(brief).toContain('confidence 0.86');
    expect(brief).toContain('659 repeated 403 errors');
  });

  it('names the exact tool call that would close each evidence gap', () => {
    const brief = buildIncidentBrief({ incident: incident(), events: events(), now: NOW });

    expect(brief).toContain('## Open evidence requirements');
    expect(brief).toContain('**LAMBDA_FAILURE_SUMMARY**');
    expect(brief).toContain(
      '- Run: query_logs on /aws/lambda/hokusai-deltaone-anomaly-detector-development'
    );
  });

  it('makes a stalled investigation obvious', () => {
    const brief = buildIncidentBrief({ incident: incident(), events: events(), now: NOW });

    expect(brief).toContain('**Last activity**: 2026-07-14T10:25:58Z (8d ago)');
    expect(brief).toContain('**Latest verification**: STILL_INCONCLUSIVE');
    expect(brief).toContain('**Still open.**');
  });

  it('does not repeat an evidence requirement that Decide copied into its follow-up actions', () => {
    const withDecision = [
      ...events(),
      {
        id: 'decide-1',
        incidentId: 'finding-3',
        runId: 'run-9',
        stage: 'Decide',
        message: 'VERIFY: next=Verify',
        severity: 'MEDIUM' as const,
        evidence: {
          disposition: 'VERIFY',
          follow_up_actions: [
            'Need error-context rows that include the remote URL or credential source. ' +
              'query_logs on /aws/lambda/hokusai-deltaone-anomaly-detector-development',
            'Check the downstream credentials and authorization policy.',
          ],
        },
        createdAt: '2026-07-14T10:25:58Z',
      },
    ];
    const brief = buildIncidentBrief({ incident: incident(), events: withDecision, now: NOW });

    expect(brief).toContain('Check the downstream credentials and authorization policy.');
    expect(brief.match(/Need error-context rows that include the remote URL/g)).toHaveLength(1);
  });

  it('records verification checks with their evidence', () => {
    const brief = buildIncidentBrief({ incident: incident(), events: events(), now: NOW });

    expect(brief).toContain('## Verification checks run');
    expect(brief).toContain('`inconclusive` find_alarms coverage — No alarms found');
  });

  it('describes an absent incident as unverified rather than resolved', () => {
    const brief = buildIncidentBrief({
      incident: incident({ state: 'absent_unverified' }),
      events: events(),
      now: NOW,
    });

    expect(brief).toContain('**Absent, not verified.**');
    expect(brief).toContain('Absence from a report is not evidence of a fix.');
    expect(brief).not.toContain('**State**: resolved');
  });

  it('omits sections it has no content for', () => {
    const brief = buildIncidentBrief({
      incident: incident(),
      events: [],
      now: NOW,
    });

    expect(brief).not.toContain('## Likely causes');
    expect(brief).not.toContain('## Timeline');
    expect(brief).toContain('# High detector errors in deltaone-anomaly-detection');
    expect(brief).not.toMatch(/\n{3,}/);
  });
});
